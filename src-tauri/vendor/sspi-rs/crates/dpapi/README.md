# dpapi-rs

This crate contains a Windows [DPAPI](https://learn.microsoft.com/en-us/windows/win32/seccng/cng-dpapi) implementation. It can encrypt the data/decrypt DPAPI blobs using the domain's root key.

It automatically makes RPC calls to obtain the root key. The user must provide credentials to authenticate in the DC.

It implements the [MS-GKDI Group Key Distribution Protocol](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-gkdi/943dd4f6-6b80-4a66-8594-80df6d2aad0a).

The original DPAPI supports many [protection descriptors](https://learn.microsoft.com/en-us/windows/win32/seccng/protection-descriptors). This library implements only SID protection descriptor.