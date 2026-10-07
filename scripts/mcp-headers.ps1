# 仅供 Codex http_headers_helper 调用；输出直接作为认证请求头，不要手动回显。
$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ZgisMcpCredential {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct Credential {
    public uint Flags, Type;
    public IntPtr TargetName, Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist, AttributeCount;
    public IntPtr Attributes, TargetAlias, UserName;
  }
  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredRead(string target, uint type, uint flags, out IntPtr value);
  [DllImport("advapi32.dll")] private static extern void CredFree(IntPtr value);
  public static string Read() {
    IntPtr value;
    if (!CredRead("zGIS/MCP", 1, 0, out value)) throw new InvalidOperationException();
    try {
      var credential = Marshal.PtrToStructure<Credential>(value);
      if (credential.CredentialBlobSize == 0 || credential.CredentialBlobSize > 1024 || credential.CredentialBlobSize % 2 != 0)
        throw new InvalidOperationException();
      return Marshal.PtrToStringUni(credential.CredentialBlob, (int)credential.CredentialBlobSize / 2);
    } finally { CredFree(value); }
  }
}
'@
  $accessToken = [ZgisMcpCredential]::Read()
  if ($accessToken -notmatch '^[0-9a-f-]{36}$') { throw 'Invalid fixed credential' }
  @{ Authorization = "Bearer $accessToken" } | ConvertTo-Json -Compress
} catch {
  [Console]::Error.WriteLine('zGIS MCP credential unavailable. Start zGIS and enable its MCP service.')
  exit 1
} finally { $accessToken = $null }
