// Twin (wasm) shim. Same names as the host_preview shim; ticks are milliseconds.
#pragma once
#include <stdint.h>
typedef void *TaskHandle_t;
typedef int BaseType_t;
#define pdMS_TO_TICKS(ms) (ms)
#define pdPASS 1
#define pdTRUE 1
#define pdFALSE 0
#define portTICK_PERIOD_MS 1
