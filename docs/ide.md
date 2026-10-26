# Web IDE

```bash
cd ide
npm install
npm run dev      # http://localhost:3000
```

- **First-run tour** of the IDE, with Skip (comes back next visit) and Don't
  show again; retake it from the Guide or the command palette
- **Several files at once**, Thonny-style: every program opens in its own tab,
  tabs come back after a refresh, unsaved ones show a dot and ask before closing.
  Middle-click closes a tab; ⌥W closes, ⌥[ / ⌥] switch
- **My programs** and **Examples** are separate views. Examples open read-only
  (book icon on the tab); "Make my own copy" or the copy button puts an editable
  one in My programs
- **Module manager**, like Arduino's Library Manager: search the library,
  Install / Update / Remove. Installing adds `use <module>` to the open program.
  The library is the repo's `modules/`; installed modules live in
  `workspace/modules/`, and only those compile into your programs (examples see
  the whole library). Writing `use bmp280` before installing it offers a
  one-click Install in the error strip
- **Compiles as you type** — errors in red on the line that caused them; board
  notes in yellow for things that compile but behave differently on the
  selected board (ADC2 with Wi-Fi on the S3, Pico W HTTP limits, USB pins…)
- **Run** (`⌘/Ctrl+Enter`) runs in the simulator with no board connected, or on
  the board when one is. The simulator pane stays hidden until you run in it or
  open it from the ribbon
- Command palette (⌘K), ⌘S save with format-on-save, a live serial REPL over
  Web Serial (Chrome or Edge; the simulator works in any browser)
- Leaving the page with unsaved changes asks first
- Hover any keyword for docs; completion knows the installed modules
  (`bmp280.` → its fields) and the selected board's pins (`set pin ` → `25 — LED`)
