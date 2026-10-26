# Basic GPIO: light the LED while the button is held
# LED and BUTTON are your board's own. No button on yours? Wire one from
# any pin to ground and put that pin's name in place of BUTTON.

repeat forever:
    if read pin BUTTON:
        set pin LED high
    else:
        set pin LED low
    sleep 20ms
