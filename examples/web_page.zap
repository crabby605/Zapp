# Become a Wi-Fi network and serve a page from the drive
# Put your page in web/index.html on the Zapp drive
# Needs a board with Wi-Fi: Pico W or any ESP32-S3.

start wifi "Zapp" with "zapp1234"
serve web
print "join Zapp, then open http://" + wifi ip
