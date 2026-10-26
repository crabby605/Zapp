#include "hal_radio.h"
#include "hal.h"

#include <stdio.h>
#include <string.h>

#include "pico/cyw43_arch.h"
#include "pico/stdlib.h"
#include "lwip/apps/http_client.h"
#include "lwip/ip4_addr.h"
#include "lwip/netif.h"
#include "lwip/tcp.h"
#include "lwip/udp.h"
#include "project_store.h"

// Wi-Fi for the Pico W / Pico 2 W (CYW43439)
// 2.4GHz 802.11n only — this part has no 5GHz radio, so there is nothing to
// configure about bands. lwIP runs in threadsafe-background mode because the VM
// lives on core 1 while USB runs on core 0; every non-callback lwIP call is
// bracketed with cyw43_arch_lwip_begin/end as the SDK requires.
//
// ponytail: one request in flight at a time and a single response buffer. That
// matches the language (`http get` is a blocking expression); a second buffer
// and a request id would be needed for concurrent requests.

#define HTTP_TIMEOUT_MS 15000

static bool radio_started = false;
static bool wifi_joined   = false;
static bool ap_up         = false;

// State for the request currently in flight.
static struct {
    char    *out;
    size_t   out_len;
    size_t   received;
    int      status;
    bool     done;
} request;

static bool radio_start(void) {
    if (radio_started) return true;
    // CYW43_COUNTRY_WORLDWIDE is the safe default; swap it for your region's
    // code (e.g. CYW43_COUNTRY_UK) if channel availability matters.
    if (cyw43_arch_init_with_country(CYW43_COUNTRY_WORLDWIDE) != 0) {
        hal_debug_println("Radio Error: CYW43 init failed");
        return false;
    }
    cyw43_arch_enable_sta_mode();
    radio_started = true;
    return true;
}

bool hal_radio_available(void) {
    return true;
}

bool hal_radio_led(bool on) {
    if (!radio_start()) return false;
    cyw43_arch_gpio_put(CYW43_WL_GPIO_LED_PIN, on);
    return true;
}

bool hal_wifi_connect(const char *ssid, const char *password, uint32_t timeout_ms) {
    if (!radio_start()) return false;

    int err = cyw43_arch_wifi_connect_timeout_ms(
        ssid, password[0] ? password : NULL,
        password[0] ? CYW43_AUTH_WPA2_AES_PSK : CYW43_AUTH_OPEN,
        timeout_ms);

    wifi_joined = (err == 0);
    if (!wifi_joined) {
        char msg[64];
        snprintf(msg, sizeof(msg), "Radio Error: could not join '%s'", ssid);
        hal_debug_println(msg);
    }
    return wifi_joined;
}

bool hal_wifi_connected(void) {
    if (!radio_started) return false;
    int status = cyw43_tcpip_link_status(&cyw43_state, CYW43_ITF_STA);
    wifi_joined = (status == CYW43_LINK_UP);
    return wifi_joined;
}

void hal_wifi_ip(char *out, size_t out_len) {
    if (!ap_up && !hal_wifi_connected()) {
        snprintf(out, out_len, "0.0.0.0");
        return;
    }
    cyw43_arch_lwip_begin();
    const ip4_addr_t *addr = netif_ip4_addr(&cyw43_state.netif[ap_up ? CYW43_ITF_AP : CYW43_ITF_STA]);
    snprintf(out, out_len, "%s", ip4addr_ntoa(addr));
    cyw43_arch_lwip_end();
}

// Access point. The driver gives the AP interface 192.168.4.1/24; lwIP has no
// DHCP server, so the one below hands out 192.168.4.16 onwards.
//
// ponytail: one lease per slot, never expired, 8 clients max. Enough for
// phones joining a gadget; age out leases if more devices need to come and go.

#define DHCP_LEASES 8

static uint8_t lease_mac[DHCP_LEASES][6];
static struct udp_pcb *dhcp_pcb;

static int dhcp_lease_for(const uint8_t *mac) {
    static const uint8_t none[6] = {0};
    for (int i = 0; i < DHCP_LEASES; i++)
        if (memcmp(lease_mac[i], mac, 6) == 0) return i;
    for (int i = 0; i < DHCP_LEASES; i++)
        if (memcmp(lease_mac[i], none, 6) == 0) { memcpy(lease_mac[i], mac, 6); return i; }
    return -1;
}

static void dhcp_recv(void *arg, struct udp_pcb *pcb, struct pbuf *p,
                      const ip_addr_t *addr, u16_t port) {
    (void)arg; (void)addr; (void)port;
    static uint8_t msg[548];
    size_t len = pbuf_copy_partial(p, msg, sizeof(msg), 0);
    pbuf_free(p);
    if (len < 240 || msg[0] != 1 || memcmp(msg + 236, "\x63\x82\x53\x63", 4) != 0) return;

    uint8_t type = 0;
    for (size_t i = 240; i + 2 < len && msg[i] != 255; i += (msg[i] == 0) ? 1 : 2 + msg[i + 1]) {
        if (msg[i] == 53) type = msg[i + 2];
    }
    if (type != 1 && type != 3) return;   // only DISCOVER and REQUEST need a reply

    int lease = dhcp_lease_for(msg + 28);
    if (lease < 0) return;

    static const uint8_t opts[] = {
        54, 4, 192, 168, 4, 1,          // server
        51, 4, 0x00, 0x01, 0x51, 0x80,  // lease: one day
        1,  4, 255, 255, 255, 0,        // netmask
        3,  4, 192, 168, 4, 1,          // router
        255,
    };
    msg[0] = 2;   // BOOTREPLY
    memset(msg + 12, 0, 8);
    msg[16] = 192; msg[17] = 168; msg[18] = 4; msg[19] = (uint8_t)(16 + lease);
    memset(msg + 240, 0, 60);
    msg[240] = 53; msg[241] = 1; msg[242] = (type == 1) ? 2 : 5;   // OFFER / ACK
    memcpy(msg + 243, opts, sizeof(opts));

    struct pbuf *out = pbuf_alloc(PBUF_TRANSPORT, 300, PBUF_RAM);
    if (!out) return;
    memcpy(out->payload, msg, 300);
    udp_sendto_if(pcb, out, IP_ADDR_BROADCAST, 68, &cyw43_state.netif[CYW43_ITF_AP]);
    pbuf_free(out);
}

bool hal_wifi_start_ap(const char *ssid, const char *password) {
    if (!radio_start()) return false;
    cyw43_arch_enable_ap_mode(ssid, password[0] ? password : NULL,
                              password[0] ? CYW43_AUTH_WPA2_AES_PSK : CYW43_AUTH_OPEN);
    cyw43_arch_lwip_begin();
    if (!dhcp_pcb) {
        dhcp_pcb = udp_new();
        if (dhcp_pcb && udp_bind(dhcp_pcb, IP_ANY_TYPE, 67) == ERR_OK) {
            udp_recv(dhcp_pcb, dhcp_recv, NULL);
        }
    }
    // The driver makes the newest interface the default; keep internet traffic on STA.
    if (wifi_joined) netif_set_default(&cyw43_state.netif[CYW43_ITF_STA]);
    cyw43_arch_lwip_end();
    ap_up = true;
    return dhcp_pcb != NULL;
}

// Web server: answers GET with a file from the drive's web/ folder, straight
// from the store. A page bigger than lwIP's send buffer goes out in pieces as
// the browser acknowledges them (web_sent), so pages can be any size the store
// holds.
//
// ponytail: reads the store without locking against a drive sync on the other
// core; a page saved mid-request can come out mixed. Copy-on-serve if that bites.

#define WEB_CONNECTIONS 4

static struct tcp_pcb *web_pcb;

typedef struct {
    const uint8_t *data;
    size_t len, sent;
    bool used;
} WebConn;

static WebConn web_conns[WEB_CONNECTIONS];

// ERR_ABRT when it had to abort: a callback must then return that to lwIP.
static err_t web_finish(struct tcp_pcb *pcb, WebConn *c) {
    if (c) c->used = false;
    tcp_arg(pcb, NULL);
    tcp_sent(pcb, NULL);
    tcp_recv(pcb, NULL);
    tcp_err(pcb, NULL);
    if (tcp_close(pcb) == ERR_OK) return ERR_OK;
    tcp_abort(pcb);
    return ERR_ABRT;
}

// Queue as much of the page as lwIP has room for; close once it's all queued
// (lwIP still delivers what's queued before the FIN).
static err_t web_push(struct tcp_pcb *pcb, WebConn *c) {
    while (c->sent < c->len) {
        size_t room = tcp_sndbuf(pcb);
        if (room == 0) break;
        size_t n = c->len - c->sent < room ? c->len - c->sent : room;
        if (tcp_write(pcb, c->data + c->sent, (u16_t)n, TCP_WRITE_FLAG_COPY) != ERR_OK) break;
        c->sent += n;
    }
    tcp_output(pcb);
    return c->sent >= c->len ? web_finish(pcb, c) : ERR_OK;
}

static err_t web_sent(void *arg, struct tcp_pcb *pcb, u16_t len) {
    (void)len;
    return arg ? web_push(pcb, arg) : ERR_OK;
}

static void web_err(void *arg, err_t err) {
    (void)err;
    if (arg) ((WebConn *)arg)->used = false;   // lwIP has already freed the pcb
}

static err_t web_respond(struct tcp_pcb *pcb, const char *req) {
    static const char missing[] = "Not found";
    char name[PROJECT_STORE_NAME_MAX] = "";
    size_t len = 0;
    const uint8_t *body = strncmp(req, "GET /", 5) == 0 && web_file_name(req + 5, name, sizeof(name))
                        ? project_store_module_data(name, &len) : NULL;
    bool found = body != NULL;
    if (!found) { body = (const uint8_t *)missing; len = sizeof(missing) - 1; }

    WebConn *c = NULL;
    for (int i = 0; i < WEB_CONNECTIONS && !c; i++) if (!web_conns[i].used) c = &web_conns[i];
    if (!c) {   // all busy: tell the browser to retry
        static const char busy[] = "HTTP/1.0 503 Service Unavailable\r\nRetry-After: 1\r\nConnection: close\r\n\r\n";
        tcp_write(pcb, busy, sizeof(busy) - 1, TCP_WRITE_FLAG_COPY);
        return web_finish(pcb, NULL);
    }

    char head[160];
    int head_len = snprintf(head, sizeof(head),
        "HTTP/1.0 %s\r\nContent-Type: %s\r\nContent-Length: %u\r\nConnection: close\r\n\r\n",
        found ? "200 OK" : "404 Not Found", found ? web_content_type(name) : "text/plain",
        (unsigned)len);
    tcp_write(pcb, head, (u16_t)head_len, TCP_WRITE_FLAG_COPY | TCP_WRITE_FLAG_MORE);

    *c = (WebConn){ .data = body, .len = len, .sent = 0, .used = true };
    tcp_arg(pcb, c);
    tcp_sent(pcb, web_sent);
    tcp_err(pcb, web_err);
    return web_push(pcb, c);
}

static err_t web_recv(void *arg, struct tcp_pcb *pcb, struct pbuf *p, err_t err) {
    (void)err;
    if (!p) return web_finish(pcb, arg);   // the browser hung up
    char req[64];
    size_t n = pbuf_copy_partial(p, req, sizeof(req) - 1, 0);
    req[n] = '\0';
    tcp_recved(pcb, p->tot_len);
    pbuf_free(p);
    if (arg) return ERR_OK;   // the request already came; ignore the rest
    return web_respond(pcb, req);
}

static err_t web_accept(void *arg, struct tcp_pcb *pcb, err_t err) {
    (void)arg;
    if (err != ERR_OK || !pcb) return ERR_VAL;
    tcp_recv(pcb, web_recv);
    return ERR_OK;
}

bool hal_web_serve(void) {
    if (!radio_start()) return false;
    if (web_pcb) return true;
    cyw43_arch_lwip_begin();
    struct tcp_pcb *pcb = tcp_new_ip_type(IPADDR_TYPE_ANY);
    if (pcb && tcp_bind(pcb, IP_ANY_TYPE, 80) == ERR_OK) web_pcb = tcp_listen(pcb);
    if (web_pcb) tcp_accept(web_pcb, web_accept);
    else if (pcb) tcp_close(pcb);
    cyw43_arch_lwip_end();
    if (!web_pcb) hal_debug_println("Network Error: could not listen on port 80");
    return web_pcb != NULL;
}

// HTTP
// lwIP hands the body back in pbufs on its callback thread; we copy what fits
// and drop the rest, because a Zapp string is 63 bytes.

static err_t http_body_cb(void *arg, struct altcp_pcb *conn, struct pbuf *p, err_t err) {
    (void)arg; (void)err;
    if (!p) return ERR_OK;

    for (struct pbuf *q = p; q != NULL; q = q->next) {
        size_t room = (request.out_len > request.received + 1)
                    ? request.out_len - request.received - 1 : 0;
        size_t take = q->len < room ? q->len : room;
        if (take) {
            memcpy(request.out + request.received, q->payload, take);
            request.received += take;
        }
    }
    request.out[request.received] = '\0';

    altcp_recved(conn, p->tot_len);
    pbuf_free(p);
    return ERR_OK;
}

static void http_result_cb(void *arg, httpc_result_t result, u32_t rx_len,
                           u32_t srv_res, err_t err) {
    (void)arg; (void)rx_len; (void)err;
    request.status = (result == HTTPC_RESULT_OK) ? (int)srv_res : 0;
    request.done = true;
}

// Split "http://host[:port]/path" into its parts. Returns false for anything
// else — https needs mbedtls and altcp_tls, which this build doesn't include.
static bool split_url(const char *url, char *host, size_t host_len,
                      uint16_t *port, char *path, size_t path_len) {
    const char *rest = url;
    if (strncmp(rest, "http://", 7) == 0) {
        rest += 7;
    } else if (strncmp(rest, "https://", 8) == 0) {
        hal_debug_println("Network Error: https is not supported, use http://");
        return false;
    }

    const char *slash = strchr(rest, '/');
    const char *colon = strchr(rest, ':');
    size_t host_end = slash ? (size_t)(slash - rest) : strlen(rest);

    *port = 80;
    if (colon && (!slash || colon < slash)) {
        *port = (uint16_t)atoi(colon + 1);
        host_end = (size_t)(colon - rest);
    }

    if (host_end == 0 || host_end >= host_len) return false;
    memcpy(host, rest, host_end);
    host[host_end] = '\0';
    snprintf(path, path_len, "%s", slash ? slash : "/");
    return true;
}

int hal_http_request(const char *method, const char *url,
                     const char *body, char *out, size_t out_len) {
    if (out_len) out[0] = '\0';
    if (!hal_wifi_connected()) {
        hal_debug_println("Network Error: not connected to wifi");
        return 0;
    }

    char host[64], path[128];
    uint16_t port;
    if (!split_url(url, host, sizeof(host), &port, path, sizeof(path))) {
        hal_debug_println("Network Error: bad url");
        return 0;
    }

    // ponytail: GET only. POST needs httpc's custom-request path plus a body
    // buffer; add it when a module actually posts.
    if (strcmp(method, "GET") != 0) {
        hal_debug_println("Network Error: only http get is supported on this board");
        return 0;
    }
    (void)body;

    request.out = out;
    request.out_len = out_len;
    request.received = 0;
    request.status = 0;
    request.done = false;

    httpc_connection_t settings;
    memset(&settings, 0, sizeof(settings));
    settings.result_fn = http_result_cb;

    cyw43_arch_lwip_begin();
    err_t err = httpc_get_file_dns(host, port, path, &settings,
                                   http_body_cb, NULL, NULL);
    cyw43_arch_lwip_end();
    if (err != ERR_OK) {
        hal_debug_println("Network Error: request could not start");
        return 0;
    }

    uint64_t deadline = time_us_64() + (uint64_t)HTTP_TIMEOUT_MS * 1000;
    while (!request.done) {
        if (time_us_64() > deadline) {
            hal_debug_println("Network Error: request timed out");
            return 0;
        }
        hal_radio_poll();
        sleep_ms(5);
    }
    return request.status;
}

void hal_radio_poll(void) {
    if (!radio_started) return;
    // Threadsafe-background mode services lwIP on its own; this keeps the
    // poll-mode build working too and costs nothing when there's no work.
    cyw43_arch_poll();
}
