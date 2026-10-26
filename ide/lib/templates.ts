// Text new files start with, shared by the API routes and the hosted (in-browser) workspace.

// The first program in an empty workspace.
export const STARTER = `# Welcome to Zapp.
# Run this with the Run button or Cmd/Ctrl+Enter — no board required.

num count = 0

repeat 3:
    count = count + 1
    print "blink " + count
    set pin 25 high
    sleep 200ms
    set pin 25 low
    sleep 200ms
`;

// A new module, with every part explained. Comments sit on their own lines:
// the module parser reads everything after `=` as the value.
export function moduleTemplate(name: string) {
    return `# A module tells Zapp how to read one part, so programs can just say
#   use ${name}
#   get data from ${name}
#   print ${name}.reading
# Fill in the numbers from your part's datasheet. Lines starting with # are notes.
# It saves by itself and is ready to use.
#
# What a module file can do: talk to I2C parts by register — read some bytes,
# turn them into a number, scale it. Parts that need more (special maths, a
# new screen type, a new GPS sentence) need support in Zapp itself.

[module]
# The name programs write after \`use\`. Lowercase letters, numbers and _.
name        = "${name}"
version     = "1.0.0"
description = "What this part is, in a few words"
author      = "me"

[compat]
# How the part is wired. Module files you write can describe i2c parts.
interface   = "i2c"

[i2c]
# The part's address. The datasheet lists it, usually written like 0x76.
addr_default = 0x76

[init]
# Settings to send once at the start, as  register = value  (one byte each).
# Many chips need one to wake up. Delete this section if yours doesn't.
0xF4 = 0x27

# One [fields.<name>] section per reading. Programs read it as ${name}.<name>.
[fields.reading]
type   = "num"
# The register the reading starts at.
reg    = 0xFA
# How its bytes make a number. u = never negative, i = can be negative.
# 8, 16, 24 or 32 bits. _be = first byte biggest, _le = first byte smallest.
#   u8  i8  u16_be  u16_le  i16_be  i16_le  u24_be  u24_le  u32_be  i32_be ...
format = "u16_be"
# Optional, applied in this order — delete any you don't need:
#   shift  = 4        drop this many low bits
#   bits   = 12       keep only this many bits (signed formats keep the sign)
#   mask   = 0x80     keep only these bits
#   scale  = 0.0625   multiply by this (the datasheet's "LSB" or "resolution")
#   offset = -40      then add this
# For a yes/no reading, set type = "bool" and use mask to pick the bit.
scale  = 1
`;
}
