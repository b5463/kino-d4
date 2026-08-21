#ifndef CAMNODE_NODE_SERVER_H
#define CAMNODE_NODE_SERVER_H

#include "esp_err.h"

esp_err_t node_server_start(const char *session_id);
void node_server_set_state(const char *state);

#endif
