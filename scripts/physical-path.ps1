if (-not ('ZgisInstallNative' -as [type])) {
Add-Type @'
using System;
using System.IO;
using System.Text;
using System.Security.Cryptography;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class ZgisInstallNative {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string path,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle h,StringBuilder buffer,uint length,uint flags);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern int GetCurrentPackageFullName(ref uint length,StringBuilder name);
 public static bool IsPackaged() {uint length=0;return GetCurrentPackageFullName(ref length,null)!=15700;}
 public static string FinalPath(string path) {
  using(var handle=CreateFileW(path,0,7,IntPtr.Zero,3,0,IntPtr.Zero)) {
   if(handle.IsInvalid)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
   var buffer=new StringBuilder(32768);
   if(GetFinalPathNameByHandleW(handle,buffer,32768,0)==0)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
   return buffer.ToString();
  }
 }
 public static string NormalizedHash(string path) {
  byte[] bytes=File.ReadAllBytes(path), from=Encoding.ASCII.GetBytes("BUNDLE_TYPE_VAR_NSS"), to=Encoding.ASCII.GetBytes("BUNDLE_TYPE_VAR_UNK");
  for(int i=0;i<=bytes.Length-from.Length;i++) {
   if(bytes[i]!=from[0])continue;
   int j=1;for(;j<from.Length && bytes[i+j]==from[j];j++);
   if(j==from.Length)Array.Copy(to,0,bytes,i,to.Length);
  }
  using(var hash=SHA256.Create())return BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-", "");
 }
}
'@
}
