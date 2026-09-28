extern crate proc_macro;

type AnyErr = Box<dyn std::error::Error>;

#[derive(Debug)]
struct Error {
    desc: String,
}

impl std::error::Error for Error {}

impl core::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.desc.fmt(f)
    }
}

impl Error {
    fn msg(s: impl Into<String>) -> Self {
        Self { desc: s.into() }
    }
}

#[proc_macro_attribute]
pub fn rename_symbol(attr: proc_macro::TokenStream, item: proc_macro::TokenStream) -> proc_macro::TokenStream {
    let attr = attr.to_string();
    let item = item.to_string();
    match rename_symbol_impl(&attr, &item) {
        Ok(output) => output.parse().expect("invalid output token stream"),
        Err(e) => format!(r####"compile_error!(r###"{e}"###); {item}"####)
            .parse()
            .unwrap(),
    }
}

// To rename symbols we convert `proc_macro::TokenStream` to `String`.
// Sometimes, it can add extra whitespaces: https://doc.rust-lang.org/stable/proc_macro/struct.TokenStream.html#impl-Display-for-TokenStream
// > Note: the exact form of the output is subject to change, e.g. there might be changes in the whitespace used between tokens.
// See more: https://github.com/Devolutions/sspi-rs/pull/591#discussion_r2764202212
const ATTR_NO_MANGLE: &str = "#[unsafe (no_mangle)]";

fn rename_symbol_impl(attr: &str, item: &str) -> Result<String, AnyErr> {
    use std::fmt::Write as _;

    let new_symbol = attr
        .strip_prefix(r#"to = ""#)
        .ok_or_else(|| Error::msg(r#"attribute must match `to = "<new symbol>"`"#))?
        .strip_suffix('"')
        .ok_or_else(|| Error::msg(r#"missing closing `"`"#))?;

    let fn_symbol = find_fn_symbol(item)?;
    let call_conv = find_calling_conv(item)?;
    let fn_token_idx = find_fn_token(item)?;
    let fn_signature = find_fn_signature(item)?;
    let fn_args = find_args(fn_signature)?;

    let mut out = String::new();

    {
        // Rewrite original implementation (without #[unsafe(no_mangle)] attribute)

        let pre = item[..fn_token_idx].replace(ATTR_NO_MANGLE, "");
        let rest = &item[fn_token_idx..];
        writeln!(out, "{pre}{rest} ")?;
    };

    {
        // Stub function with the new name

        writeln!(
            out,
            r#"#[unsafe(no_mangle)] pub unsafe extern "{call_conv}" fn {new_symbol}{fn_signature} {{"#
        )?;
        writeln!(out, "\t{fn_symbol}(")?;
        for arg in fn_args {
            writeln!(out, "\t\t{arg},")?;
        }
        writeln!(out, "\t)")?;
        writeln!(out, "}}")?;
    }

    Ok(out)
}

fn find_fn_token(item: &str) -> Result<usize, AnyErr> {
    let fn_token_idx = item.find("fn").ok_or_else(|| Error::msg("expected a function"))?;
    Ok(fn_token_idx)
}

fn find_fn_symbol(item: &str) -> Result<&str, AnyErr> {
    let fn_token_idx = find_fn_token(item)?;

    let open_parenth_idx = item[fn_token_idx..]
        .find('(')
        .map(|idx| idx + fn_token_idx)
        .ok_or_else(|| Error::msg("expected opening delimiter `(`"))?;
    let end_idx = item[fn_token_idx..open_parenth_idx]
        .find('<')
        .map(|idx| idx + fn_token_idx)
        .unwrap_or(open_parenth_idx);

    Ok(&item[fn_token_idx + 3..end_idx])
}

fn find_fn_signature(item: &str) -> Result<&str, AnyErr> {
    let fn_token_idx = find_fn_token(item)?;

    let open_parenth_idx = item[fn_token_idx..]
        .find('(')
        .map(|idx| idx + fn_token_idx)
        .ok_or_else(|| Error::msg("expected opening delimiter `(`"))?;
    let fn_symbol_end_idx = item[fn_token_idx..open_parenth_idx]
        .find('<')
        .map(|idx| idx + fn_token_idx)
        .unwrap_or(open_parenth_idx);

    let opening_curly_brace_idx = item[fn_symbol_end_idx..]
        .find('{')
        .map(|idx| idx + fn_symbol_end_idx)
        .ok_or_else(|| Error::msg("expected opening delimiter `{`"))?;

    Ok(&item[fn_symbol_end_idx..opening_curly_brace_idx])
}

fn find_calling_conv(item: &str) -> Result<&str, AnyErr> {
    let fn_token_idx = find_fn_token(item)?;

    let extern_keyword_idx = item[..fn_token_idx]
        .find("extern")
        .ok_or_else(|| Error::msg("expected `extern` keyword"))?;

    let call_conv_start_idx = extern_keyword_idx + 8;
    let call_conv_end_idx = item[call_conv_start_idx..]
        .find('"')
        .map(|idx| idx + call_conv_start_idx)
        .ok_or_else(|| Error::msg(r#"expected closing delimiter `"`"#))?;

    Ok(&item[call_conv_start_idx..call_conv_end_idx])
}

fn find_args(signature: &str) -> Result<Vec<&str>, AnyErr> {
    let open_parenth_idx = signature
        .find('(')
        .ok_or_else(|| Error::msg("expected opening delimiter `(`"))?;
    let close_parenth_idx = signature
        .find(')')
        .ok_or_else(|| Error::msg("expected closing delimiter `)`"))?;
    let parameters = &signature[open_parenth_idx + 1..close_parenth_idx];

    let parameters = parameters
        .split(',')
        .filter_map(|param| {
            let end_idx = param.find(':')?;
            Some(param[..end_idx].trim().trim_start_matches("mut "))
        })
        .collect();

    Ok(parameters)
}
