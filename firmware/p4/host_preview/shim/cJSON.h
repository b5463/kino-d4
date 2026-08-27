// Host shim. The preview never touches a JSON document - it only needs the
// type to exist so config_store.h's declarations compile.
#pragma once

typedef struct cJSON cJSON;
