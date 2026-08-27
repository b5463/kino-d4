#include "mesh3d.h"

#include <math.h>
#include <string.h>

#include "esp_heap_caps.h"
#include "esp_log.h"

static const char *TAG = "mesh3d";

#define RGB565(r, g, b) ((uint16_t)((((r) & 0xF8) << 8) | (((g) & 0xFC) << 3) | ((b) >> 3)))

/* Sized for the one model that exists, with room to grow it.
 *
 * These were 1800 and 2200, which is what six models needed before five of
 * them were removed - 69 KB of .bss held for a camera that uses 356 vertices
 * and 368 triangles. On a part whose DIRAM was 70 percent full, that is the
 * cheapest 50 KB in the firmware. build_camera() reports its actual counts at
 * boot, so overrunning these is visible rather than silent. */
#define MAX_VERTS 640
#define MAX_TRIS 700

typedef struct {
  float x, y, z;
} vec3;

typedef struct {
  uint16_t a, b, c;
  uint8_t r, g, b8;
  uint8_t gloss;  /* 0 matte, 255 wet. The XP look lives here. */
  uint8_t smooth; /* interpolate the vertex normals rather than facet it */
} tri;

typedef struct {
  uint16_t v0, nv;
  uint16_t t0, nt;
  vec3 centre;
  float radius;
} model_t;

static vec3 s_v[MAX_VERTS];
static vec3 s_n[MAX_VERTS]; /* per-vertex normal, only read by smooth tris */
static tri s_t[MAX_TRIS];
static int s_nv, s_nt;
static model_t s_model[M3_COUNT];
static vec3 *s_view;
static vec3 *s_vnorm;
static uint16_t *s_depth;
static int s_vw, s_vh;
static bool s_ready;

bool mesh3d_ready(void) { return s_ready; }

/* ------------------------------------------------------------------ */
/* Model construction                                                  */
/* ------------------------------------------------------------------ */

/* Current material. Set before emitting geometry rather than threaded through
 * every call, because every builder below wants it constant for a whole part
 * and eight extra arguments per primitive made the models unreadable. */
static uint8_t m_r, m_g, m_b, m_gloss, m_smooth;

static void material(uint8_t r, uint8_t g, uint8_t b, uint8_t gloss) {
  m_r = r;
  m_g = g;
  m_b = b;
  m_gloss = gloss;
  m_smooth = 0;
}

static int add_vert(float x, float y, float z) {
  if (s_nv >= MAX_VERTS) return s_nv - 1;
  s_v[s_nv] = (vec3){x, y, z};
  s_n[s_nv] = (vec3){0, 0, 0};
  return s_nv++;
}

/* A vertex that carries its own normal, for surfaces that should read as
 * curved. The normals are analytic - we know a cylinder's normal exactly -
 * rather than averaged from neighbouring faces, which avoids needing
 * smoothing groups and is correct at the seam where the ring closes. */
static int add_vert_n(float x, float y, float z, float nx, float ny, float nz) {
  const int i = add_vert(x, y, z);
  const float l = sqrtf(nx * nx + ny * ny + nz * nz);
  if (l > 1e-6f) s_n[i] = (vec3){nx / l, ny / l, nz / l};
  return i;
}

static void add_tri(int a, int b, int c) {
  if (s_nt >= MAX_TRIS) return;
  s_t[s_nt++] = (tri){(uint16_t)a, (uint16_t)b, (uint16_t)c, m_r, m_g, m_b, m_gloss, m_smooth};
}

static void add_quad(int a, int b, int c, int d) {
  add_tri(a, b, c);
  add_tri(a, c, d);
}

static void add_box(float cx, float cy, float cz, float hw, float hh, float hd) {
  const int v0 = add_vert(cx - hw, cy - hh, cz - hd);
  const int v1 = add_vert(cx + hw, cy - hh, cz - hd);
  const int v2 = add_vert(cx + hw, cy + hh, cz - hd);
  const int v3 = add_vert(cx - hw, cy + hh, cz - hd);
  const int v4 = add_vert(cx - hw, cy - hh, cz + hd);
  const int v5 = add_vert(cx + hw, cy - hh, cz + hd);
  const int v6 = add_vert(cx + hw, cy + hh, cz + hd);
  const int v7 = add_vert(cx - hw, cy + hh, cz + hd);
  add_quad(v0, v3, v2, v1);
  add_quad(v4, v5, v6, v7);
  add_quad(v0, v1, v5, v4);
  add_quad(v3, v7, v6, v2);
  add_quad(v0, v4, v7, v3);
  add_quad(v1, v2, v6, v5);
}

/**
 * A tube between two z planes, optionally capped.
 *
 * The side wall carries radial vertex normals and is flagged smooth, so a
 * twelve-segment barrel shades as a cylinder rather than as twelve flat
 * strips. Caps get their own vertices with axial normals - sharing them with
 * the wall would mean one vertex needing two different normals, which is
 * exactly the seam that makes a faceted edge look melted.
 */
static void add_cyl(float cx, float cy, float z0, float z1, float radius, int segs,
                    bool cap_front, bool cap_back) {
  const int base = s_nv;
  m_smooth = 1;
  for (int i = 0; i < segs; i++) {
    const float a = (float)i * 6.2831853f / (float)segs;
    const float nx = cosf(a), ny = sinf(a);
    add_vert_n(cx + radius * nx, cy + radius * ny, z0, nx, ny, 0.0f);
    add_vert_n(cx + radius * nx, cy + radius * ny, z1, nx, ny, 0.0f);
  }
  for (int i = 0; i < segs; i++) {
    const int j = (i + 1) % segs;
    add_quad(base + i * 2, base + j * 2, base + j * 2 + 1, base + i * 2 + 1);
  }
  m_smooth = 0;

  if (cap_front) {
    const int ring = s_nv;
    for (int i = 0; i < segs; i++) {
      const float a = (float)i * 6.2831853f / (float)segs;
      add_vert(cx + radius * cosf(a), cy + radius * sinf(a), z1);
    }
    const int c = add_vert(cx, cy, z1);
    for (int i = 0; i < segs; i++) add_tri(c, ring + i, ring + (i + 1) % segs);
  }
  if (cap_back) {
    const int ring = s_nv;
    for (int i = 0; i < segs; i++) {
      const float a = (float)i * 6.2831853f / (float)segs;
      add_vert(cx + radius * cosf(a), cy + radius * sinf(a), z0);
    }
    const int c = add_vert(cx, cy, z0);
    for (int i = 0; i < segs; i++) add_tri(c, ring + (i + 1) % segs, ring + i);
  }
}

/* ------------------------------------------------------------------ */
/* The six objects                                                     */
/*                                                                     */
/* Saturated, chunky and glossy, after the reference camera's icon set: */
/* bright plastic under a hard key light. Muted greys and a realistic   */
/* falloff turned every one of these into a silhouette at 130 px.       */
/* ------------------------------------------------------------------ */

/* The real camera bar: 22 mm pitch, centres at -33, -11, +11, +33 mm. */
static const float LENS_X[4] = {-33.0f, -11.0f, 11.0f, 33.0f};
#define LENS_R 9.0f
#define BODY_W 96.0f
#define BODY_H 60.0f
#define BODY_D 34.0f

static void build_camera(void) {
  /* Colours are design-system tokens: --blue for the body, --blue-hi for the
   * glass, --yellow for the flash. The camera has to look like it belongs to
   * the same product as Studio's chrome. */
  material(0x2f, 0x70, 0xc9, 200); /* --blue */
  add_box(0, -4, 0, BODY_W * 0.5f, BODY_H * 0.5f, BODY_D * 0.5f);
  material(0xdf, 0xe7, 0xf1, 235); /* silver deck, so the form has two planes */
  add_box(0, BODY_H * 0.5f - 3.0f, 0, BODY_W * 0.5f - 2.0f, 4.0f, BODY_D * 0.5f - 1.0f);

  material(0x26, 0x2e, 0x38, 150); /* the rigid bar the four lenses share */
  add_box(0, 4, BODY_D * 0.5f + 2.0f, 46.0f, 14.0f, 2.0f);
  for (int i = 0; i < 4; i++) {
    material(0x1c, 0x22, 0x2b, 190);
    add_cyl(LENS_X[i], 4.0f, BODY_D * 0.5f, BODY_D * 0.5f + 13.0f, LENS_R, 16, false, false);
    material(0x6e, 0xa3, 0xe8, 255); /* --blue-hi glass, the brightest face */
    add_cyl(LENS_X[i], 4.0f, BODY_D * 0.5f + 12.4f, BODY_D * 0.5f + 12.8f, LENS_R * 0.70f, 16,
            true, false);
  }
  material(0xf4, 0xc5, 0x42, 255); /* --yellow flash, offset from the bar */
  add_box(0, -20.0f, BODY_D * 0.5f + 1.5f, 10.0f, 6.0f, 1.5f);
}

static void finish_model(m3_model_t id, int v0, int t0) {
  model_t *m = &s_model[id];
  m->v0 = (uint16_t)v0;
  m->nv = (uint16_t)(s_nv - v0);
  m->t0 = (uint16_t)t0;
  m->nt = (uint16_t)(s_nt - t0);

  /* Bounding sphere about the mean vertex. Not the tightest possible sphere,
   * but the framing only has to be consistent across the set, and a mean is
   * stable where a min/max centre lurches when one spike is added. */
  vec3 c = {0, 0, 0};
  for (int i = v0; i < s_nv; i++) {
    c.x += s_v[i].x;
    c.y += s_v[i].y;
    c.z += s_v[i].z;
  }
  if (m->nv) {
    c.x /= (float)m->nv;
    c.y /= (float)m->nv;
    c.z /= (float)m->nv;
  }
  float rad = 1.0f;
  for (int i = v0; i < s_nv; i++) {
    const float dx = s_v[i].x - c.x, dy = s_v[i].y - c.y, dz = s_v[i].z - c.z;
    const float d = sqrtf(dx * dx + dy * dy + dz * dz);
    if (d > rad) rad = d;
  }
  m->centre = c;
  m->radius = rad;
}

esp_err_t mesh3d_init(int vw, int vh) {
  if (s_ready) return ESP_OK;
  s_nv = 0;
  s_nt = 0;

  const int v0 = s_nv, t0 = s_nt;
  build_camera();
  finish_model(M3_CAMERA, v0, t0);

  s_view = heap_caps_malloc(sizeof(vec3) * MAX_VERTS, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  s_vnorm = heap_caps_malloc(sizeof(vec3) * MAX_VERTS, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  s_depth = heap_caps_malloc((size_t)vw * vh * sizeof(uint16_t), MALLOC_CAP_SPIRAM);
  if (s_view == NULL || s_vnorm == NULL || s_depth == NULL) {
    ESP_LOGE(TAG, "no room for depth buffer / transform scratch");
    return ESP_ERR_NO_MEM;
  }
  s_vw = vw;
  s_vh = vh;
  s_ready = true;

  ESP_LOGI(TAG, "models built: %d verts, %d tris total", s_nv, s_nt);
  return ESP_OK;
}

/* ------------------------------------------------------------------ */
/* Rasteriser                                                          */
/* ------------------------------------------------------------------ */

/* Key light, in view space: upper left, slightly toward the viewer. -z is
 * toward the camera and +y is up the screen, which is what the projection
 * below assumes. */
#define LX (-0.40f)
#define LY (0.62f)
#define LZ (-0.68f)
/* Half vector for Blinn-Phong with the viewer at (0, 0, -1). Constant,
 * because an orthographic view direction is close enough at icon size and
 * this way it is computed once rather than per pixel. */
#define HX (LX)
#define HY (LY)
#define HZ (LZ - 1.0f)

void mesh3d_draw(uint16_t *canvas, int cw, int ch, int vx, int vy, int vw, int vh,
                 m3_model_t model, float yaw, float pitch, float zoom, uint16_t bg) {
  if (!s_ready || canvas == NULL || model < 0 || model >= M3_COUNT) return;
  if (vw <= 0 || vh <= 0) return;
  /* Grow the depth buffer rather than quietly drawing a smaller picture.
   *
   * This used to clamp the viewport to whatever mesh3d_init() was given, and
   * the icon builder asks for a 504 px supersampled field while init was
   * called with 320x300. The camera therefore rendered into the top-left
   * corner of the field at about 60 percent size and was then downsampled as
   * if it filled it - which is why its zoom kept having to be raised to
   * "match" the drawn icons. It was never a framing problem; it was a clamp.
   * A silent clamp on a size is nearly always a bug waiting to be found by
   * eye, which is the most expensive way to find one. */
  if (vw > s_vw || vh > s_vh) {
    const size_t want = (size_t)vw * vh * sizeof(uint16_t);
    uint16_t *bigger = heap_caps_realloc(s_depth, want, MALLOC_CAP_SPIRAM);
    if (bigger == NULL) {
      ESP_LOGE(TAG, "depth buffer cannot grow to %dx%d; drawing clamped", vw, vh);
      if (vw > s_vw) vw = s_vw;
      if (vh > s_vh) vh = s_vh;
    } else {
      s_depth = bigger;
      s_vw = vw;
      s_vh = vh;
      ESP_LOGI(TAG, "depth buffer grown to %dx%d", vw, vh);
    }
  }
  (void)ch;

  for (int y = 0; y < vh; y++) {
    uint16_t *row = canvas + (size_t)(vy + y) * cw + vx;
    for (int x = 0; x < vw; x++) row[x] = bg;
  }
  memset(s_depth, 0xFF, (size_t)vw * vh * sizeof(uint16_t));

  const float hl = sqrtf(HX * HX + HY * HY + HZ * HZ);
  const float hx = HX / hl, hy = HY / hl, hz = HZ / hl;

  const model_t *m = &s_model[model];
  const float cy_ = cosf(yaw), sy_ = sinf(yaw);
  const float cp = cosf(pitch), sp = sinf(pitch);

  const int shorter = vw < vh ? vw : vh;
  const float focal = (float)shorter * 1.15f;
  /* Distance at which the bounding sphere exactly fills the shorter axis.
   *
   * The `+ radius` that used to be added here to keep the near face off the
   * camera cost far more than it bought: it pushed every object back by a
   * whole radius, so a model ended up covering about 40 percent of its icon
   * instead of filling it. A fraction of a radius is enough clearance, and
   * the near-plane test below catches anything that still comes too close. */
  const float fit = m->radius * focal / ((float)shorter * 0.5f);
  const float dist = fit / (zoom > 0.05f ? zoom : 1.0f) + m->radius * 0.35f;

  for (int i = 0; i < m->nv; i++) {
    const int src = m->v0 + i;
    const float x = s_v[src].x - m->centre.x;
    const float y = s_v[src].y - m->centre.y;
    const float z = s_v[src].z - m->centre.z;
    const float x1 = x * cy_ + z * sy_;
    const float z1 = -x * sy_ + z * cy_;
    const float y2 = y * cp - z1 * sp;
    const float z2 = y * sp + z1 * cp;
    /* Right-handed model space into the left-handed view space the projection
     * below assumes: negate z only.
     *
     * The camera sits at the origin looking down +z, so nearer means smaller
     * z, and a model's own +z - the side everything interesting is built on -
     * has to end up nearer. Negating x as well, on the theory that a lone z
     * flip would mirror the picture, was wrong twice over: a lone z flip is
     * the standard handedness conversion and mirrors nothing, while negating
     * both is a half turn about Y, which really did mirror every model
     * left-to-right. It went unnoticed for as long as every object was
     * symmetric; the film canister's leader and the crate's letter A are what
     * finally showed it, both sitting on the wrong side.
     *
     * The flip reverses triangle winding, which is harmless here: backface
     * culling is off and the shading is two-sided. */
    s_view[i] = (vec3){x1, y2, dist - z2};
    /* Normals ride the same transform. No translation and no scale, so this
     * is exact. */
    const float nx = s_n[src].x, ny = s_n[src].y, nz = s_n[src].z;
    const float nx1 = nx * cy_ + nz * sy_;
    const float nz1 = -nx * sy_ + nz * cy_;
    s_vnorm[i] = (vec3){nx1, ny * cp - nz1 * sp, -(ny * sp + nz1 * cp)};
  }

  const float half_w = (float)vw * 0.5f, half_h = (float)vh * 0.5f;

  /* Depth normalisation, referenced to this model at this distance.
   *
   * The previous version multiplied by a fixed constant, which for a model at
   * about 1.9 radii put every near surface at roughly -283000 before
   * clamping. Everything in front therefore landed on 0, and since the test
   * rejects equal depths, whichever part happened to be built first won: the
   * camera body hid all four lens barrels, and the gallery cards hid the
   * photographs printed on them. Mapping this model's actual near and far
   * planes onto the full 16-bit range is what lets the buffer tell two
   * surfaces a fraction of a millimetre apart from each other. */
  const float znear = (dist - m->radius) > 0.5f ? (dist - m->radius) : 0.5f;
  const float izmax = 1.0f / znear;
  const float izmin = 1.0f / (dist + m->radius);
  const float dspan = (izmax - izmin) > 1e-6f ? (izmax - izmin) : 1e-6f;
  const float dscale = 65535.0f / dspan;

  for (int k = 0; k < m->nt; k++) {
    const tri *tr = &s_t[m->t0 + k];
    const int ia = tr->a - m->v0, ib = tr->b - m->v0, ic = tr->c - m->v0;
    const vec3 a = s_view[ia], b = s_view[ib], c = s_view[ic];
    if (a.z < 1.0f || b.z < 1.0f || c.z < 1.0f) continue;

    const float ax = half_w + a.x * focal / a.z, ay = half_h - a.y * focal / a.z;
    const float bx = half_w + b.x * focal / b.z, by = half_h - b.y * focal / b.z;
    const float cx2 = half_w + c.x * focal / c.z, cy2 = half_h - c.y * focal / c.z;

    const float area = (bx - ax) * (cy2 - ay) - (by - ay) * (cx2 - ax);
    /* No backface culling: the depth buffer already resolves which surface is
     * in front, and culling only pays off if every model is wound
     * consistently. A winding mistake with culling on makes faces silently
     * vanish; with it off the worst case is wasted fill. */
    if (area > -0.5f && area < 0.5f) continue;

    /* Face normal, used directly by flat triangles and as the fallback for a
     * smooth one whose vertex normals were never set. */
    const float ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
    const float vx2 = c.x - a.x, vy2 = c.y - a.y, vz2 = c.z - a.z;
    float fnx = uy * vz2 - uz * vy2;
    float fny = uz * vx2 - ux * vz2;
    float fnz = ux * vy2 - uy * vx2;
    const float fl = sqrtf(fnx * fnx + fny * fny + fnz * fnz);
    if (fl < 1e-6f) continue;
    fnx /= fl;
    fny /= fl;
    fnz /= fl;

    const bool smooth = tr->smooth != 0;
    const float gloss = (float)tr->gloss / 255.0f;

    int x0 = (int)floorf(fminf(ax, fminf(bx, cx2)));
    int x1i = (int)ceilf(fmaxf(ax, fmaxf(bx, cx2)));
    int y0 = (int)floorf(fminf(ay, fminf(by, cy2)));
    int y1i = (int)ceilf(fmaxf(ay, fmaxf(by, cy2)));
    if (x0 < 0) x0 = 0;
    if (y0 < 0) y0 = 0;
    if (x1i > vw - 1) x1i = vw - 1;
    if (y1i > vh - 1) y1i = vh - 1;
    if (x0 > x1i || y0 > y1i) continue;

    const float inv_area = 1.0f / area;
    const float iza = 1.0f / a.z, izb = 1.0f / b.z, izc = 1.0f / c.z;
    const vec3 na = s_vnorm[ia], nb = s_vnorm[ib], nc = s_vnorm[ic];

    /* Flat triangles light once for the whole face rather than per pixel. */
    float flat_shade = 0.0f, flat_spec = 0.0f;
    if (!smooth) {
      float d = fnx * LX + fny * LY + fnz * LZ;
      if (d < 0.0f) d = -d; /* two-sided: light the side that faces us */
      float s = fnx * hx + fny * hy + fnz * hz;
      if (s < 0.0f) s = -s;
      flat_shade = 0.46f + 0.54f * d;
      flat_spec = gloss * powf(s, 14.0f);
    }

    for (int y = y0; y <= y1i; y++) {
      const float py = (float)y + 0.5f;
      uint16_t *crow = canvas + (size_t)(vy + y) * cw + vx;
      uint16_t *drow = s_depth + (size_t)y * vw;
      for (int x = x0; x <= x1i; x++) {
        const float px = (float)x + 0.5f;
        const float w0 = ((bx - px) * (cy2 - py) - (by - py) * (cx2 - px)) * inv_area;
        const float w1 = ((cx2 - px) * (ay - py) - (cy2 - py) * (ax - px)) * inv_area;
        const float w2 = 1.0f - w0 - w1;
        if (w0 < 0.0f || w1 < 0.0f || w2 < 0.0f) continue;

        const float iz = w0 * iza + w1 * izb + w2 * izc;
        /* Interpolated in 1/z, which is what is linear in screen space; z
         * itself bends the surface. Nearest maps to 0, so "smaller wins"
         * holds against the 0xFFFF the buffer was cleared to. */
        int depth = (int)((izmax - iz) * dscale);
        if (depth < 0) depth = 0;
        if (depth > 65535) depth = 65535;
        if ((uint16_t)depth >= drow[x]) continue;

        float shade, spec;
        if (smooth) {
          /* Phong: interpolate the normal and light per pixel, which is what
           * turns a sixteen-sided barrel into a cylinder with a highlight
           * running down it instead of sixteen flat bands. */
          float nx = w0 * na.x + w1 * nb.x + w2 * nc.x;
          float ny = w0 * na.y + w1 * nb.y + w2 * nc.y;
          float nz = w0 * na.z + w1 * nb.z + w2 * nc.z;
          const float l = sqrtf(nx * nx + ny * ny + nz * nz);
          if (l < 1e-6f) continue;
          nx /= l;
          ny /= l;
          nz /= l;
          float d = nx * LX + ny * LY + nz * LZ;
          if (d < 0.0f) d = -d;
          float s = nx * hx + ny * hy + nz * hz;
          if (s < 0.0f) s = -s;
          shade = 0.46f + 0.54f * d;
          spec = gloss * powf(s, 14.0f);
        } else {
          shade = flat_shade;
          spec = flat_spec;
        }

        /* Diffuse term keeps the hue; the specular adds white on top, which
         * is what reads as a glossy plastic rather than a brighter colour. */
        const float hi = spec * 235.0f;
        int rr = (int)(tr->r * shade + hi);
        int gg = (int)(tr->g * shade + hi);
        int bb = (int)(tr->b8 * shade + hi);
        if (rr > 255) rr = 255;
        if (gg > 255) gg = 255;
        if (bb > 255) bb = 255;

        drow[x] = (uint16_t)depth;
        crow[x] = RGB565(rr, gg, bb);
      }
    }
  }
}
