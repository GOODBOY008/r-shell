using System;
using System.Reflection;
using System.Runtime.InteropServices;

namespace Devolutions.Sspi;

public static unsafe partial class Sspi
{
    static Sspi()
    {
        NativeLibrary.SetDllImportResolver(typeof(Sspi).Assembly, DllImportResolver);  
    }

    static IntPtr DllImportResolver(string libraryName, Assembly assembly, DllImportSearchPath? searchPath)
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Create("iOS")))
        {
            return NativeLibrary.Load("Frameworks/lib" + libraryName + ".framework/lib" + libraryName, assembly, searchPath);
        }
        else
        {
            return NativeLibrary.Load(libraryName, assembly, searchPath);
        }
    }
}
