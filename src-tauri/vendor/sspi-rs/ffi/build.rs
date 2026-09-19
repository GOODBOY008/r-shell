use std::path::PathBuf;
use std::{env, fs};

#[cfg(target_os = "windows")]
mod win {
    use std::env;
    use std::fs::File;
    use std::io::Write;
    use std::path::PathBuf;

    fn generate_version_rc() -> String {
        let version = env::var("CARGO_PKG_VERSION").unwrap();
        let version_parts: Vec<&str> = version.split('.').collect();

        // Pad to 4 components (e.g., "0.18.7" -> "0.18.7.0")
        let mut version_numbers = version_parts.clone();
        while version_numbers.len() < 4 {
            version_numbers.push("0");
        }

        let version_commas = version_numbers.join(",");
        let version_dots = version_numbers.join(".");

        let company_name = "Devolutions Inc.";
        let file_description = "Devolutions SSPI";
        let product_name = "Devolutions SSPI";
        let original_filename = "sspi.dll";
        let legal_copyright = "Copyright 2019-2026 Devolutions Inc.";

        format!(
            r#"#include <winver.h>

VS_VERSION_INFO VERSIONINFO
FILEVERSION {version_commas}
PRODUCTVERSION {version_commas}
FILEFLAGSMASK VS_FFI_FILEFLAGSMASK
FILEFLAGS 0x0L
FILEOS VOS_NT_WINDOWS32
FILETYPE VFT_DLL
FILESUBTYPE VFT2_UNKNOWN
BEGIN
    BLOCK "StringFileInfo"
    BEGIN
        BLOCK "040904B0"
        BEGIN
            VALUE "CompanyName", "{company_name}"
            VALUE "FileDescription", "{file_description}"
            VALUE "FileVersion", "{version_dots}"
            VALUE "InternalName", "{original_filename}"
            VALUE "LegalCopyright", "{legal_copyright}"
            VALUE "OriginalFilename", "{original_filename}"
            VALUE "ProductName", "{product_name}"
            VALUE "ProductVersion", "{version_dots}"
        END
    END
    BLOCK "VarFileInfo"
    BEGIN
        VALUE "Translation", 0x409, 1200
    END
END
"#
        )
    }

    pub(crate) fn embed_version_info() {
        let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
        let version_rc_file = out_dir.join("version.rc");
        let version_rc_data = generate_version_rc();

        let mut file = File::create(&version_rc_file).expect("Failed to create version.rc file");
        file.write_all(version_rc_data.as_bytes())
            .expect("Failed to write version.rc file");

        let _ = embed_resource::compile(&version_rc_file, embed_resource::NONE);
    }
}

fn main() {
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap();
    let is_running_tests = env::var("SSPI_RS_IS_RUNNING_TESTS").is_ok();

    if target_os == "windows" && !is_running_tests {
        // Embed version information in the DLL
        #[cfg(target_os = "windows")]
        win::embed_version_info();
        // On Windows, we provide the linker with a .def file to rename exports.
        // This module definition file is used to rename some symbols
        // and avoid linkage conflicts with secur32.dll when building the library.
        // (secur32.dll is used by `rust-tls-native-roots` crate)

        // See:
        // https://docs.microsoft.com/en-us/cpp/build/reference/module-definition-dot-def-files
        // https://docs.microsoft.com/en-us/cpp/build/reference/exports

        let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
        let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
        let base_def_file = manifest_dir.join("sspi_base.def");
        let merged_def_file = out_dir.join("sspi_merged.def");

        let mut merged_content = fs::read_to_string(&base_def_file).expect("Failed to read sspi_base.def");

        #[cfg(feature = "scard")]
        {
            let scard_def_file = manifest_dir.join("sspi_winscard.def");
            let scard_content = fs::read_to_string(&scard_def_file).expect("Failed to read sspi_winscard.def");
            let filtered_scard_content: String = scard_content
                .lines()
                .filter(|line| line.starts_with("    "))
                .collect::<Vec<_>>()
                .join("\n");
            merged_content.push('\n');
            merged_content.push_str(&filtered_scard_content);
        }

        #[cfg(feature = "dpapi")]
        {
            let dpapi_def_file = manifest_dir.join("sspi_dpapi.def");
            let dpapi_content = fs::read_to_string(&dpapi_def_file).expect("Failed to read sspi_dpapi.def");
            let filtered_dpapi_content: String = dpapi_content
                .lines()
                .filter(|line| line.starts_with("    "))
                .collect::<Vec<_>>()
                .join("\n");
            merged_content.push('\n');
            merged_content.push_str(&filtered_dpapi_content);
        }

        fs::write(&merged_def_file, merged_content).expect("Failed to write merged .def file");
        println!("cargo:rustc-link-arg=/DEF:{}", merged_def_file.display());
    }

    if !is_running_tests {
        let mut csbindgen_builder = csbindgen::Builder::default()
            .input_extern_file("src/logging.rs")
            .input_extern_file("src/sspi/common.rs")
            .input_extern_file("src/sspi/sec_handle.rs")
            .input_extern_file("src/sspi/sec_pkg_info.rs")
            .input_extern_file("src/sspi/sec_winnt_auth_identity.rs")
            .input_extern_file("src/sspi/security_tables.rs")
            .input_extern_file("src/sspi/sec_buffer.rs")
            .input_extern_file("src/sspi/sspi_data_types.rs");

        #[cfg(feature = "dpapi")]
        {
            csbindgen_builder = csbindgen_builder
                .input_extern_file("src/dpapi/mod.rs")
                .input_extern_file("src/dpapi/api.rs");
        }

        #[cfg(feature = "scard")]
        {
            csbindgen_builder = csbindgen_builder
                .input_extern_file("src/winscard/mod.rs")
                .input_extern_file("src/winscard/scard_context.rs")
                .input_extern_file("src/winscard/scard.rs")
                .input_extern_file("../crates/ffi-types/src/winscard/functions.rs")
                .input_extern_file("../crates/ffi-types/src/winscard/mod.rs")
                .input_extern_file("../crates/ffi-types/src/common.rs");
        }

        csbindgen_builder
            .csharp_namespace("Devolutions.Sspi")
            .csharp_class_name("Sspi")
            .csharp_class_accessibility("public")
            .csharp_dll_name("DevolutionsSspi")
            .generate_csharp_file("dotnet/Devolutions.Sspi/Sspi.g.cs")
            .expect("generate C# bindings");
    }
}
