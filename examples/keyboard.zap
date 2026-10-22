# The board as a USB keyboard: press the button on GP15 to type a phrase
# Plug the board into the computer you want it to type on.

repeat forever:
    if read pin 15:
        type "hello from zapp"
        press "enter"
        sleep 1s
    sleep 50ms
