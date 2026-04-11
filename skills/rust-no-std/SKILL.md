---
name: rust-no-std
description: "Rust #![no_std]: core/alloc/std tiers, panic handlers, OOM handling, feature-gated portability, embedded memory layout, host testing. Load for no_std libraries, embedded/bare-metal targets, or dual-mode crates."
license: MIT
user-invocable: true
metadata:
  author: vanillagreen
  version: "1.0.0"
---

# Rust no_std Development

Patterns for `#![no_std]` libraries, embedded targets, and dual-mode crates.

## Resources

Documentation lookup order: local skill files -> ctx7 CLI -> web fallback.

### ctx7 CLI

| Library | ctx7 ID | Use For |
|---------|---------|---------|
| Rust std | `/websites/doc_rust-lang_stable_std` | core, alloc, no_std attribute, lang items |
| embedded-hal | `/rust-embedded/embedded-hal` | Hardware abstraction traits for embedded |
| heapless | `/rust-embedded/heapless` | Fixed-capacity collections without alloc |

## Skill Rules

### Environment Tiers

Core vs alloc vs std tier selection and crate-level declarations. Always start from core and escalate only when required.

#### no_std Declaration

Place `#![no_std]` at the crate root to opt out of the standard library. For bare-metal targets, also use `#![no_main]` to disable the default runtime entry point. Use `extern crate alloc;` when alloc features are needed. For dual-mode libraries, use `#![cfg_attr(not(feature = "std"), no_std)]`.

**Incorrect (missing no_std declaration):**

```rust
// lib.rs — no declaration, implicitly links std
use std::vec::Vec;

pub fn sum(values: &[i32]) -> i32 {
    values.iter().sum()
}
```

**Correct (conditional no_std for dual-mode library):**

```rust
// lib.rs
#![cfg_attr(not(feature = "std"), no_std)]

#[cfg(feature = "alloc")]
extern crate alloc;

#[cfg(feature = "alloc")]
use alloc::vec::Vec;

pub fn sum(values: &[i32]) -> i32 {
    values.iter().sum()
}

#[cfg(feature = "alloc")]
pub fn collect_sums(slices: &[&[i32]]) -> Vec<i32> {
    slices.iter().map(|s| sum(s)).collect()
}
```

For bare-metal binaries:

```rust
#![no_std]
#![no_main]

// No fn main() — entry point provided by runtime crate (e.g., cortex-m-rt)
```

### Panic and Allocator

In no_std environments, you must provide your own panic handler and, if using `alloc`, a global allocator. The binary will not link without them.

#### OOM Handler

When allocation fails, the default behavior is to panic. In embedded systems, prefer fallible APIs (`Vec::try_reserve`, `Box::try_new`) over infallible ones. On nightly, use `#[alloc_error_handler]` for custom OOM behavior. On stable, use `alloc::alloc::set_alloc_error_hook`.

**Incorrect (ignoring allocation failure):**

```rust
#![no_std]
extern crate alloc;
use alloc::vec::Vec;

fn collect_data(count: usize) -> Vec<u8> {
    // Panics on OOM — unacceptable in safety-critical embedded
    let mut v = Vec::with_capacity(count);
    v.resize(count, 0);
    v
}
```

**Correct (fallible allocation):**

```rust
#![no_std]
extern crate alloc;
use alloc::vec::Vec;

#[derive(Debug)]
pub enum Error {
    OutOfMemory,
}

fn collect_data(count: usize) -> Result<Vec<u8>, Error> {
    let mut v = Vec::new();
    v.try_reserve(count).map_err(|_| Error::OutOfMemory)?;
    v.resize(count, 0);
    Ok(v)
}
```

**Correct (custom alloc error handler on nightly):**

```rust
#![no_std]
#![feature(alloc_error_handler)]
extern crate alloc;

use core::alloc::Layout;

#[alloc_error_handler]
fn oom(_layout: Layout) -> ! {
    // Log the failure, then halt
    // defmt::error!("OOM: size={}, align={}", layout.size(), layout.align());
    loop {
        core::hint::spin_loop();
    }
}
```

On stable Rust, use `alloc::alloc::set_alloc_error_hook` to register a hook instead.

### Portable Library Design

Feature-gated std support, core-only API patterns, and error handling without std. Libraries that support both std and no_std consumers reach the widest audience. Careful API design with feature gates makes this achievable.

#### Feature-Gated std

Use Cargo features to let consumers choose their tier. Default to `std` for ergonomics; no_std consumers opt in with `default-features = false`. Structure features hierarchically: `std` implies `alloc`, `alloc` implies core-only.

**Incorrect (no feature gates -- forces std on all consumers):**

```toml
# Cargo.toml
[dependencies]
serde = "1"
```

```rust
// lib.rs
use std::io::Write;
use std::collections::HashMap;
```

**Correct (feature-gated Cargo.toml):**

```toml
# Cargo.toml
[features]
default = ["std"]
std = ["alloc", "serde/std"]
alloc = ["serde/alloc"]

[dependencies]
serde = { version = "1", default-features = false, features = ["derive"] }
```

```rust
// lib.rs
#![cfg_attr(not(feature = "std"), no_std)]

#[cfg(feature = "alloc")]
extern crate alloc;

// Core API — always available
pub mod parser;

// Alloc API — needs allocator
#[cfg(feature = "alloc")]
pub mod collections;

// Std API — needs OS
#[cfg(feature = "std")]
pub mod io_utils;
```

#### Core API Pattern

Design core APIs with zero allocation. Accept `&[T]` not `Vec<T>`, accept `&str` not `String`, return references or write to caller-provided buffers. Gate convenience methods that allocate behind the `alloc` feature.

**Incorrect (API requires allocation):**

```rust
pub fn parse_tokens(input: &str) -> Vec<Token> {
    let mut tokens = Vec::new();
    // ... parsing logic ...
    tokens
}

pub fn format_message(parts: &[&str]) -> String {
    parts.join(", ")
}
```

**Correct (core API with optional alloc convenience):**

```rust
/// Core API: writes tokens to caller-provided buffer, returns count.
pub fn parse_tokens_into<'a>(
    input: &'a str,
    buf: &mut [Token<'a>],
) -> usize {
    let mut count = 0;
    // ... parsing logic, writing to buf ...
    count
}

/// Core API: writes formatted message to any `core::fmt::Write`.
pub fn format_message(
    parts: &[&str],
    writer: &mut dyn core::fmt::Write,
) -> core::fmt::Result {
    for (i, part) in parts.iter().enumerate() {
        if i > 0 {
            writer.write_str(", ")?;
        }
        writer.write_str(part)?;
    }
    Ok(())
}

/// Alloc convenience: collects all tokens into a Vec.
#[cfg(feature = "alloc")]
pub fn parse_tokens(input: &str) -> alloc::vec::Vec<Token> {
    let mut tokens = alloc::vec::Vec::new();
    // ... parsing logic ...
    tokens
}
```

#### Error Handling

`std::error::Error` is not available in core. Use `core::fmt::Display` for error messages and conditionally implement `std::error::Error` when the `std` feature is enabled. Use `core::fmt::Write` for string formatting without alloc.

**Incorrect (unconditionally using std::error::Error):**

```rust
use std::error::Error;
use std::fmt;

#[derive(Debug)]
pub enum ParseError {
    InvalidInput,
    Overflow,
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidInput => write!(f, "invalid input"),
            Self::Overflow => write!(f, "numeric overflow"),
        }
    }
}

impl Error for ParseError {}
```

**Correct (conditional std::error::Error):**

```rust
use core::fmt;

#[derive(Debug)]
pub enum ParseError {
    InvalidInput,
    Overflow,
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidInput => write!(f, "invalid input"),
            Self::Overflow => write!(f, "numeric overflow"),
        }
    }
}

#[cfg(feature = "std")]
impl std::error::Error for ParseError {}
```

Use `core::fmt::Write` for string formatting without alloc:

```rust
use core::fmt::Write;

struct FixedBuf {
    buf: [u8; 128],
    pos: usize,
}

impl Write for FixedBuf {
    fn write_str(&mut self, s: &str) -> core::fmt::Result {
        let bytes = s.as_bytes();
        let remaining = self.buf.len() - self.pos;
        if bytes.len() > remaining {
            return Err(core::fmt::Error);
        }
        self.buf[self.pos..self.pos + bytes.len()].copy_from_slice(bytes);
        self.pos += bytes.len();
        Ok(())
    }
}
```

### Embedded Patterns

Entry points, memory layout, and HAL abstraction for bare-metal targets. These patterns apply when targeting microcontrollers and other embedded platforms where there is no OS.

#### Memory Layout

Embedded targets require explicit memory layout via linker scripts. The `memory.x` file defines FLASH and RAM regions for the target MCU. Configure `.cargo/config.toml` for the target and linker script. Optimize release profile for binary size.

**memory.x (example for STM32F411):**

```
MEMORY
{
    FLASH : ORIGIN = 0x08000000, LENGTH = 512K
    RAM   : ORIGIN = 0x20000000, LENGTH = 128K
}
```

**.cargo/config.toml:**

```toml
[target.thumbv7em-none-eabihf]
runner = "probe-run --chip STM32F411CEUx"
rustflags = [
    "-C", "link-arg=-Tlink.x",
]

[build]
target = "thumbv7em-none-eabihf"
```

**Incorrect (debug-friendly settings in release for embedded):**

```toml
[profile.release]
opt-level = 2        # Not size-optimized
# lto = false        # Missing LTO
# panic = "unwind"   # Unwinding pulls in massive code
```

**Correct (release profile minimizing binary size):**

```toml
[profile.release]
opt-level = "z"      # Optimize for size
lto = true           # Link-time optimization
panic = "abort"      # No unwinding — saves significant space
codegen-units = 1    # Better optimization, slower compile
strip = true         # Strip symbols
```

### Testing

Host-based testing strategies and hardware mocking for no_std code. Testing no_std code requires strategies for both fast host iteration and hardware validation.

#### Host Testing

Use conditional compilation to enable std during test builds. This lets you run logic tests on the host with `cargo test` while keeping the library no_std in production.

**Incorrect (no test support in no_std crate):**

```rust
#![no_std]

// Can't run `cargo test` — no test harness without std
pub fn add(a: u32, b: u32) -> u32 {
    a + b
}
```

**Correct (conditional no_std for host testing):**

```rust
#![cfg_attr(not(test), no_std)]

pub fn add(a: u32, b: u32) -> u32 {
    a + b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_add() {
        assert_eq!(add(2, 3), 5);
    }

    #[test]
    fn test_add_overflow() {
        assert_eq!(add(u32::MAX, 0), u32::MAX);
    }
}
```

For alloc-gated tests:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(feature = "alloc")]
    fn test_collect_results() {
        extern crate alloc;
        use alloc::vec;

        let input = &[1, 2, 3];
        let result = collect_all(input);
        assert_eq!(result, vec![1, 2, 3]);
    }
}
```

Mock hardware dependencies with traits to enable host testing:

```rust
pub trait Clock {
    fn now_ms(&self) -> u64;
}

pub struct Scheduler<C: Clock> {
    clock: C,
    next_tick: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    struct MockClock(u64);
    impl Clock for MockClock {
        fn now_ms(&self) -> u64 { self.0 }
    }

    #[test]
    fn test_scheduler() {
        let clock = MockClock(1000);
        let sched = Scheduler { clock, next_tick: 500 };
        // Test scheduling logic without real hardware
    }
}
```
