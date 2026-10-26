# The board as a USB keyboard: press the button to type a phrase
# Plug the board into the computer you want it to type on.
# No button on your board? Wire one from any pin to ground and use that pin.

repeat forever:
    if read pin BUTTON:
        type "hello from zapp"
        press "enter"
        sleep 1s
    sleep 50ms
