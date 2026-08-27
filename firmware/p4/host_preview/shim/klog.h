// Host shim. The preview has no log ring; klog is a no-op.
#pragma once

void klog(const char *src, const char *fmt, ...);
