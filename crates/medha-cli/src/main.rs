//! The `medha` command. Everything lives in the library (`medha_cli`), which the NAPI binding
//! (`crates/medha-napi`) also uses to open homes, so the CLI and the SDK share one implementation.

fn main() {
    medha_cli::main();
}
