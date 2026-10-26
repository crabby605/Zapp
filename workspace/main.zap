# Welcome to Zapp!
# Run this with the Run button or Cmd/Ctrl+Enter — no board required.

num count = 0

repeat 3:
    count = count + 1
    print "blink " + count
    set pin 25 high
    sleep 200ms
    set pin 25 low
    sleep 200ms
connect wifi to "network" with "password"
  