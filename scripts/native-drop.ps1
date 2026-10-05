param([Parameter(Mandatory=$true)][int]$TargetProcessId, [Parameter(Mandatory=$true)][string[]]$Files)
$ErrorActionPreference = 'Stop'
$target = Get-Process -Id $TargetProcessId
if ($target.ProcessName -ne 'zgis') { throw 'Target must be the isolated zGIS test process.' }
$paths = @($Files | ForEach-Object { (Resolve-Path -LiteralPath $_).Path })
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public static class NativeFileDropSmoke {
 [StructLayout(LayoutKind.Sequential)] public struct Rect {public int Left, Top, Right, Bottom;}
 [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
 [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra);
 public static string Drop(IntPtr target, string[] files) {
  Rect rect; if(!GetWindowRect(target,out rect)) throw new Exception("No target window");
  SetForegroundWindow(target);
  SetCursorPos(rect.Left + 150,rect.Top + 160);
  using(var control = new Control()) {
   var sourceHandle = control.Handle;
   var data = new DataObject(DataFormats.FileDrop,files);
   using(var timer = new Timer()) {
    int ticks = 0;
    timer.Interval=100;
    timer.Tick += (s,e) => {ticks++; SetCursorPos(rect.Left+150,rect.Top+160); if(ticks==3) mouse_event(4,0,0,0,UIntPtr.Zero);};
    control.QueryContinueDrag += (s,e) => { if(ticks>50) e.Action=DragAction.Cancel; };
    mouse_event(2,0,0,0,UIntPtr.Zero);
    timer.Start();
    try { return control.DoDragDrop(data,DragDropEffects.Copy).ToString(); }
    finally {timer.Stop();mouse_event(4,0,0,0,UIntPtr.Zero);}
   }
  }
 }
}
"@
$result = [NativeFileDropSmoke]::Drop($target.MainWindowHandle, $paths)
Write-Output "Windows OLE FileDrop effect: $result"
if ($result -ne 'Copy') { throw 'Native target did not accept file drop.' }
