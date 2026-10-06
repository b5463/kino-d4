"""P4-sized carrier datum, viewed from the carrier's component side.

Guition JC4880P443C_I_W/Y mechanical drawing, landscape orientation.
The inner insert pitch is also corroborated by the project's bench records.
The pattern offset remains drawing-derived; it has not passed a physical fit.
"""
WIDTH = 117.01
HEIGHT = 69.41
# KINO_FIELD_BODY's normative four-camera baseline. All modules share an
# orientation; their common optical offset cannot change the 22 mm pitch.
CAMERA_PITCH = 22.0
CAMERA_CENTRES = [(WIDTH/2 + (i-1.5)*CAMERA_PITCH, HEIGHT/2) for i in range(4)]
LENS_OFFSET_Y = -6.95  # Enclosure CAD datum, not measured lens metrology.
INSERT_PITCH = (61.9, 54.8)
INSERT_OFFSET = (-9.3, 0.0)
INSERT_CENTRES = [
    (round(WIDTH/2+INSERT_OFFSET[0]+sx*INSERT_PITCH[0]/2,3),
     round(HEIGHT/2+INSERT_OFFSET[1]+sy*INSERT_PITCH[1]/2,3))
    for sx,sy in [(-1,-1),(1,-1),(-1,1),(1,1)]
]
INSERT_THREAD = 'M2; thread engagement must be checked on the actual insert'
INSERT_CLEARANCE_DIAMETER = 2.2
FASTENER_KEEP_OUT = 7.0
OFFICIAL_SPEC = 'https://www.guition.com/icms/upload/fb081940d6fc11f09850077a33e1404f/file/productmanager-productfile/5dfbe9a7c0fc44869270528bd2411b1e/Directory/JC4880P443C_I_W%20Specifications-EN-V1.0_1776241869964.pdf'
STRUCTURE_MIRROR = 'https://github.com/wegi1/ESP32P4-JC4880P443C-I-W/blob/main/3-Structure_Diagram/JC4880P443C_I_W_Y-%E6%A8%A1%E5%9E%8B.pdf'

def overlaps(a,b):
    x,y,w,h=a;u,v,s,t=b
    return x<u+s-1e-6 and u<x+w-1e-6 and y<v+t-1e-6 and v<y+h-1e-6

def subtract(free, used):
    result=[]
    for r in free:
        if not overlaps(r,used):result.append(r);continue
        x,y,w,h=r;u,v,s,t=used
        if u>x:result.append((x,y,u-x,h))
        if u+s<x+w:result.append((u+s,y,x+w-u-s,h))
        if v>y:result.append((x,y,w,v-y))
        if v+t<y+h:result.append((x,v+t,w,y+h-v-t))
    # MaxRects free regions overlap; remove contained regions, not shared areas.
    unique=list(dict.fromkeys(tuple(round(n,6) for n in r) for r in result if r[2]>.01 and r[3]>.01))
    return [r for i,r in enumerate(unique) if not any(i!=j and r[0]>=s[0]-1e-6 and r[1]>=s[1]-1e-6
            and r[0]+r[2]<=s[0]+s[2]+1e-6 and r[1]+r[3]<=s[1]+s[3]+1e-6 for j,s in enumerate(unique))]

def pack(items, fixed):
    """Courtyard-only feasibility placement. It is not a routed/thermal layout."""
    free=[(1.5,1.5,WIDTH-3,HEIGHT-3)]
    for r in fixed:free=subtract(free,r)
    output={}
    for ref,w,h in sorted(items,key=lambda c:(-max(c[1:]),-c[1]*c[2],c[0])):
        choices=[]
        for x,y,fw,fh in free:
            for turn,ww,hh in [(0,w,h),(90,h,w)]:
                if ww<=fw+1e-6 and hh<=fh+1e-6:
                    choices.append(((min(fw-ww,fh-hh),max(fw-ww,fh-hh),y,x),x,y,ww,hh,turn))
        if not choices:raise ValueError(('P4 envelope cannot fit remaining courtyard',ref,w,h))
        _,x,y,ww,hh,turn=min(choices)
        output[ref]=(x,y,turn)
        free=subtract(free,(x,y,ww,hh))
    return output
