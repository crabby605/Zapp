# Zapp

Hardware for humans. A programming language and runtime for microcontrollers.

Zapp compiles to allocation-free bytecode that runs on a dual-core VM. No GC pauses, no toolchain, no drivers. Write code in a browser, flash it to your board.

```zap
config:
    i2c sda=20 scl=21

use bmp280

repeat forever:
    get data from bmp280
    print bmp280.temp
    sleep 1s
```

## Try it

No board needed: the web IDE runs programs in a simulator.

```bash
git clone --recursive https://github.com/crabby605/Zapp.git
cd Zapp/ide
npm install
npm run dev      # http://localhost:3000
```

To run on hardware, flash the firmware for your board ([Building](docs/building.md)),
plug it in, and press Run.

## Docs

- [Language](docs/language.md): variables, GPIO, timing, PWM, displays, UART, SPI, HID
- [Boards](docs/boards.md): supported boards and pin names like `LED` and `BUTTON`
- [Modules](docs/modules.md): `.zappmod` sensor definitions, and how to write one
- [Radios](docs/radios.md): Wi-Fi, web pages and Bluetooth LE
- [REPL and USB drive](docs/repl.md): the serial prompt, LLM mode, editing `main.zap` as a file
- [Web IDE](docs/ide.md)
- [Building](docs/building.md): firmware, compiler, emulator, tests
- [Internals](docs/internals.md): architecture, project layout, opcodes
- [Spec](SPEC.md)

## License

MIT, see [LICENSE](LICENSE).
