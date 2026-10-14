/* Host shim: just enough FreeRTOS for a mutex, backed by pthreads. */
#pragma once

#include <stdint.h>

typedef uint32_t TickType_t;
typedef int BaseType_t;
#define portMAX_DELAY ((TickType_t)0xffffffffu)
#define pdTRUE 1
