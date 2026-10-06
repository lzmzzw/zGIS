param([int]$AppPid, [string]$FilePath, [switch]$Cancel)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class NativeDialog {
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr h, int id);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, string l);
  [DllImport("user32.dll", EntryPoint="SendMessageW")] public static extern IntPtr SendButton(IntPtr h, uint m, IntPtr w, IntPtr l);
  private delegate bool EnumCallback(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr h, EnumCallback callback, IntPtr l);
  [DllImport("user32.dll")] private static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr h, StringBuilder name, int length);
  public static IntPtr FindFilenameEdit(IntPtr dialog) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(dialog, (h, l) => {
      var name = new StringBuilder(256);
      GetClassName(h, name, name.Capacity);
      if (GetDlgCtrlID(h) == 1001 && name.ToString() == "Edit") { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
$pidCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $AppPid)
$classCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ClassNameProperty, '#32770')
$condition = [System.Windows.Automation.AndCondition]::new($pidCondition, $classCondition)
$deadline = (Get-Date).AddSeconds(12)
$dialog = $null
while ((Get-Date) -lt $deadline -and -not $dialog) {
  $dialog = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $condition)
  if (-not $dialog) { Start-Sleep -Milliseconds 150 }
}
if (-not $dialog) { throw 'Native file dialog not found' }
$handle = [IntPtr]$dialog.Current.NativeWindowHandle
if ($Cancel) {
  $cancelButton = [NativeDialog]::GetDlgItem($handle, 2)
  [NativeDialog]::SendButton($cancelButton, 0xF5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
  Write-Output 'Cancelled native file dialog'
  exit
}
$filenameControl = [NativeDialog]::GetDlgItem($handle, 1148)
if ($filenameControl -eq [IntPtr]::Zero) {
  # 新版通用对话框可能尚未发布 UIA Edit 类型，按原生控件 ID 定位嵌套输入框。
  $controlDeadline = (Get-Date).AddSeconds(3)
  do {
    $filenameControl = [NativeDialog]::FindFilenameEdit($handle)
    if ($filenameControl -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 100 }
  } while ($filenameControl -eq [IntPtr]::Zero -and (Get-Date) -lt $controlDeadline)
}
if ($filenameControl -ne [IntPtr]::Zero) {
  [NativeDialog]::SendMessage($filenameControl, 0xC, [IntPtr]::Zero, $FilePath) | Out-Null
  $acceptButton = [NativeDialog]::GetDlgItem($handle, 1)
  [NativeDialog]::SendButton($acceptButton, 0xF5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
  Write-Output 'Accepted native file dialog'
  exit
}
$nodes = $dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
if ($Cancel) {
  $button = $nodes | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $_.Current.Name -match '取消|Cancel' } | Select-Object -First 1
  $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  Write-Output 'Cancelled native file dialog'
  exit
}
$edit = $nodes | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -and ($_.Current.AutomationId -eq '1001' -or $_.Current.Name -match '文件名|File name') } | Select-Object -Last 1
if (-not $edit) {
  $nodes | ForEach-Object { "$($_.Current.ControlType.ProgrammaticName) | $($_.Current.AutomationId) | $($_.Current.Name)" }
  throw 'Filename control not found'
}
$edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($FilePath)
$button = $nodes | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $_.Current.Name -match '^(打开|保存|Open|Save)' } | Select-Object -First 1
if (-not $button) { throw 'Open/save button not found' }
$button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
Write-Output 'Accepted native file dialog'
