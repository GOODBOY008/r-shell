using System.Runtime.InteropServices;
using Devolutions.Sspi;

namespace PackageTests;

public class UnitTests
{
    [Fact]
    public void DpapiUnprotectSecret_Calling_ReturnsResultValue()
    {
        unsafe
        {
            byte[] blob = "some encrypted stuff, a terrible secret"u8.ToArray();

            IntPtr serverUnmanaged = Marshal.StringToCoTaskMemUTF8("hostname");
            IntPtr usernameUnmanaged = Marshal.StringToCoTaskMemUTF8("user");
            IntPtr passwordUnmanaged = Marshal.StringToCoTaskMemUTF8("password");
            IntPtr computerNameUnmanaged = Marshal.StringToCoTaskMemUTF8(Environment.MachineName);

            fixed (byte* pBlob = blob)
            {

                byte* secret;
                uint secretLen;
                uint returnCode = Sspi.DpapiUnprotectSecret(
                    pBlob,
                    (uint)blob.Length,
                    (byte*)serverUnmanaged,
                    (byte*)usernameUnmanaged,
                    (byte*)passwordUnmanaged,
                    (byte*)computerNameUnmanaged,
                    null,
                    null,
                    &secret,
                    &secretLen);
                
                Marshal.ZeroFreeCoTaskMemUTF8(serverUnmanaged);
                Marshal.ZeroFreeCoTaskMemUTF8(usernameUnmanaged);
                Marshal.ZeroFreeCoTaskMemUTF8(passwordUnmanaged);
                Marshal.ZeroFreeCoTaskMemUTF8(computerNameUnmanaged);
                
                Assert.True(returnCode is 0 or >= 0x8000000 and < 0x90000000);
            }
        }
    }

    [Fact]
    public void SspiInitSecurityInterface_Calling_HasPlausibleVersion()
    {
        
        unsafe
        {
            SecurityFunctionTableW* sspiTablePtr = Sspi.InitSecurityInterfaceW();

            SecurityFunctionTableW sspiTable = *sspiTablePtr;
            
            Assert.InRange<uint>(sspiTable.dwVersion, 0, 1000);
        }
    }
}
