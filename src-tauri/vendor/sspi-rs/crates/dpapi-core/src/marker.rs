/// Bound used by other traits when a context struct is required.
pub trait NeedsContext {
    /// Required context.
    type Context<'ctx>;
}

/// Represents named PDU.
pub trait StaticName {
    /// Static name of the PDU.
    const NAME: &'static str;
}
