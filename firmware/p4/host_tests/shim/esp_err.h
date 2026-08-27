/*
 * Host shim: the whole of esp_err.h that meta.c needs, which is the typedef.
 *
 * Deliberately its own directory rather than reusing host_preview/shim. That
 * one also carries a stub cJSON.h for the renderer, and putting it on the
 * include path here shadowed ESP-IDF's real cJSON.h — every cJSON call
 * resolved as an implicit int and the build failed with a page of
 * int-conversion errors. A shim directory containing exactly one header
 * cannot shadow anything by accident.
 */
#pragma once

typedef int esp_err_t;
#define ESP_OK 0
#define ESP_FAIL -1
