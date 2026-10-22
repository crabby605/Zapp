# Pico W: become a Wi-Fi network and serve a page from the drive
# Put your page in web/index.html on the Zapp drive
# Build the radio firmware first: cmake .. -DZAPP_BOARD=pico_w

start wifi "Zapp" with "zapp1234"
serve web
print "join Zapp, then open http://" + wifi ip
