## Summary

<!-- What problem does this change solve? Keep it focused. -->

## Testing

<!-- How did you verify the change? Paste commands or describe manual steps. -->

- [ ] `npm --prefix ui run typecheck`
- [ ] `npm --prefix ui run lint`
- [ ] `npm --prefix ui run test`
- [ ] `cargo clippy --workspace --all-targets -- -D warnings`
- [ ] `cargo test -p qsdb-studio-core`

## Checklist

- [ ] No credentials, internal hostnames, customer data, or local environment files
- [ ] Public behavior changes are documented
- [ ] Tests added or updated where practical
- [ ] I agree my contribution may be distributed under the project license
