"""Produce an actual-size P4 mounting check sheet. Requires PyMuPDF."""
from pathlib import Path
import pymupdf as pdf
from mechanical import WIDTH, HEIGHT, INSERT_CENTRES, CAMERA_CENTRES, LENS_OFFSET_Y

ROOT=Path(__file__).resolve().parent.parent
mm=72/25.4
d=pdf.open();p=d.new_page(width=210*mm,height=297*mm)
def label(x,y,text,size=10):p.insert_text((x*mm,y*mm),text,fontsize=size)
label(20,20,'KINO A0 - P4 mounting template',16)
label(20,28,'DRAFT / PRINT AT 100% / DO NOT USE FIT-TO-PAGE',10)
label(20,35,'Carrier component-side view, P4 behind this sheet; do not mirror.',9)
ox,oy=35,52
p.draw_rect(pdf.Rect(ox*mm,oy*mm,(ox+WIDTH)*mm,(oy+HEIGHT)*mm),width=.6)
for i,(x,y) in enumerate(INSERT_CENTRES,1):
    centre=pdf.Point((ox+x)*mm,(oy+y)*mm)
    p.draw_circle(centre,1.1*mm,width=.5)
    p.draw_circle(centre,3.5*mm,width=.35,dashes='[2 2]')
    p.draw_line(centre+pdf.Point(-2.5*mm,0),centre+pdf.Point(2.5*mm,0),width=.3)
    p.draw_line(centre+pdf.Point(0,-2.5*mm),centre+pdf.Point(0,2.5*mm),width=.3)
    label(ox+x+4,oy+y+1,f'H{i}',8)
for i,(x,y) in enumerate(CAMERA_CENTRES):
    p.draw_rect(pdf.Rect((ox+x-9)*mm,(oy+y-10.5)*mm,(ox+x+9)*mm,(oy+y+10.5)*mm),width=.3)
    label(ox+x-5,oy+y,f'CAM {i+1}',8)
    lens=pdf.Point((ox+x)*mm,(oy+y+LENS_OFFSET_Y)*mm)
    p.draw_circle(lens,1.5*mm,width=.3)
    p.draw_line(lens+pdf.Point(-2*mm,0),lens+pdf.Point(2*mm,0),width=.3)
label(35,130,'Outline: 117.01 x 69.41 mm. Four holes: diameter 2.2 mm for M2.',9)
label(35,136,'Inner insert pitch: 61.9 x 54.8 mm. Dashed circles: screw clearance.',9)
label(35,142,'Pattern offset: -9.3 mm in X, 0 in Y from module centre.',9)
label(35,148,'Offset is drawing-derived; physical fit and spacer height remain unverified.',9)
label(35,154,'Camera centres: 22.00 mm pitch / 66.00 mm outer span. Lens marks: CAD datum.',9)
label(35,160,'Hole centres from the carrier top-left (mm):',10)
for i,(x,y) in enumerate(INSERT_CENTRES,1):label(35,160+6*i,f'H{i}: X {x:.3f}, Y {y:.3f}',9)
label(35,193,'Use the INNER brass inserts, not the outer case screw pattern.',9)
label(35,199,'Extension spacers are needed to clear the P4 components and header.',9)
label(35,205,'Battery tray, cable access and final component placement are unfinished.',9)
p.draw_line(pdf.Point(35*mm,222*mm),pdf.Point(135*mm,222*mm),width=.6)
for x in (35,135):p.draw_line(pdf.Point(x*mm,220*mm),pdf.Point(x*mm,224*mm),width=.6)
label(70,230,'100.00 mm scale check',10)
label(35,242,'Source: Guition JC4880P443C_I_W/Y mechanical drawing;',8)
label(35,247,'insert pitch and M2 thread cross-checked against KINO bench records.',8)
d.set_metadata({'title':'KINO A0 P4 mounting template - unverified physical fit','author':'KINO contributors'})
d.save(ROOT/'outputs/P4-MOUNTING-TEMPLATE-1TO1.pdf')
p.get_pixmap(matrix=pdf.Matrix(1.4,1.4)).save(ROOT/'outputs/P4-MOUNTING-TEMPLATE.png')
