cmake_minimum_required(VERSION 3.16)

# No EXTRA_COMPONENT_DIRS, unlike p4/ and camnode/. Those two add
# firmware/components to reach kdp_core and node_link; this image must not be
# able to reach either. A radio coprocessor that can speak KDP is a second
# place for the camera's protocol to drift, and the C6 has no business owning
# any of it. Everything above the host link belongs to the P4.

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(kino-c6)
