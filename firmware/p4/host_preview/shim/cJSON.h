// Host shim.
//
// The preview never builds a JSON document - it drives the drawing code with
// globals instead of a config store - but ui.c writes every setting through
// cJSON, so the constructors have to exist for it to compile. preview.c
// defines them as stubs that allocate nothing and are never called.
#pragma once

#include <stdbool.h>

typedef struct cJSON cJSON;

cJSON *cJSON_CreateObject(void);
cJSON *cJSON_CreateString(const char *s);
cJSON *cJSON_CreateNumber(double v);
cJSON *cJSON_CreateBool(bool v);
void cJSON_AddItemToObject(cJSON *obj, const char *key, cJSON *item);
void cJSON_Delete(cJSON *item);
