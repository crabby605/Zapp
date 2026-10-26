# REPL

When connected via serial (USB CDC), you get an interactive prompt:

```
Zapp v0.1.0 on rp2040 (core)
Type 'help' for commands. Ctrl+C = stop, Ctrl+D = reload.

> help
> set pin 25 high
> read pin 15
> identity
> reset
```

## Keyboard shortcuts

- **Ctrl+C** — stop running program
- **Ctrl+D** — soft reload (re-runs the last flashed program)

`BC:<hex>` runs bytecode **and saves it** as the boot program (the IDE's Flash).
`RUN:<hex>` runs it without saving — the REPL and one-off tools like `i2c scan`
use it, so they never overwrite your program.

## LLM mode

Magic bytes switch the REPL into a machine-readable framing: `ZPP!` enters (the
board replies `ZPPA`), every command is then answered with `ZPPA` on success or
`ZPPE` on error and no prompt or echo is sent, and `ZPPX` returns to the human
REPL.

**Identify.** Send `ZPP?` at any time, in any mode, and a Zapp board answers
`ZPPI ZAPP:rp2040:core:2048:264:<board>` on its own line. It also sends that line
by itself whenever a host opens the port. The IDE, REPL and MCP server only
treat a port as a Zapp board once it has answered, so they never latch onto
some other USB serial device.

The MCP server in `mcp/` speaks this protocol:

```bash
claude mcp add zapp -- npx tsx mcp/server.ts     # or use the checked-in .mcp.json
```

Tools: `zapp_list_boards`, `zapp_connect`, `zapp_run`, `zapp_emulate`,
`zapp_compile`, `zapp_gpio_write`, `zapp_gpio_read`, `zapp_i2c_scan`,
`zapp_repl`, `zapp_stop`, `zapp_read_output`, `zapp_list_modules`,
`zapp_disconnect`.

# USB drive (CircuitPython-style)

The board mounts as a `Zapp Drive` USB drive with:

```
Zapp Drive/
  main.zap          ← edit this file to program
  boot_out.txt      ← board info (read-only)
  modules/           ← .zappmod sensor files
```

Save `main.zap` (or drop `.zappmod` files into `modules/`) and it syncs to flash
within 1 second; deleting a module file removes it from the board too. The board
can't compile source yet, so the running program doesn't change: the REPL prints
`main.zap saved. Flash it from the Zapp IDE to run your changes.` and
`ZAPP:SRC_CHANGED`, and you press Flash in the IDE.
