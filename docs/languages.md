# Language Support

CortexAST ships with 3 statically-linked **core languages** and supports 8+ more via **dynamic Wasm grammars** downloaded from GitHub tree-sitter releases.

## Core Languages (always active)

| Language   | Extensions       | Parser  |
|------------|-----------------|---------|
| Rust       | `.rs`           | Static  |
| TypeScript | `.ts`, `.tsx`   | Static  |
| Python     | `.py`           | Static  |

## Wasm Languages (installed on demand)

Call `cortex_manage_ast_languages` with `action=add` and `languages=[...]` to download and hot-reload:

| Language | Extensions                            | Install name |
|----------|---------------------------------------|-------------|
| Go       | `.go`                                 | `go`        |
| PHP      | `.php`, `.php5`, `.phtml`             | `php`       |
| C++      | `.cpp`, `.cc`, `.cxx`, `.hpp`, `.hxx` | `cpp`       |
| C        | `.c`, `.h`                            | `c`         |
| C#       | `.cs`                                 | `c_sharp`   |
| Java     | `.java`                               | `java`      |
| Ruby     | `.rb`, `.rake`                        | `ruby`      |
| Dart     | `.dart`                               | `dart`      |

### Example

```json
{
  "action": "add",
  "languages": ["go", "php", "cpp", "c_sharp"]
}
```

Grammars are cached in `~/.cortex-works/grammars/` and hot-reloaded without server restart.
Source: [GitHub tree-sitter releases](https://github.com/tree-sitter)
