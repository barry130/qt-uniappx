"""Reproducible native PNG materials for the reference-style player.
Own artwork, not a crop of the user's reference. No CSS gradients/shadows.
All coordinates share a 2000 x 1800 canvas; record box is (180,170,1560,1560).
Run with the bundled Python/Pillow/numpy. Preview is a material proof, not a device screenshot.
"""
from pathlib import Path
import math
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'uni_modules/qt-ui/static/player-turntable'
OUT.mkdir(parents=True, exist_ok=True)
W, H = 2000, 1800
CX, CY, R = 960, 950, 780

def save_asset(image, name):
    # 1500px canvas covers high-density phones without 2000px decode overhead.
    size = (round(image.width * .75), round(image.height * .75))
    image.resize(size, Image.Resampling.LANCZOS).save(OUT / name, optimize=True)

def layer():
    return Image.new('RGBA', (W, H))

def circle(image, xy, radius, fill, outline=None, width=1):
    x, y = xy
    ImageDraw.Draw(image).ellipse((x-radius,y-radius,x+radius,y+radius),fill=fill,outline=outline,width=width)

def shadow(shape, blur=15, shift=(8,12), opacity=44):
    mask = shape.getchannel('A').filter(ImageFilter.GaussianBlur(blur))
    mask = mask.point(lambda a: a * opacity // 255)
    black = Image.new('RGBA', shape.size, (45,53,65,0)); black.putalpha(mask)
    moved = Image.new('RGBA', shape.size); moved.paste(black,shift)
    return moved

def metallic_disc(center, radius):
    # Shaped face with a cool grey edge and a broad porcelain highlight.
    im = layer()
    x0,y0 = center
    for rr in range(radius,0,-1):
        t = rr/radius
        v = int(226 + 19*(1-t) + 10*math.exp(-((t-.87)/.08)**2))
        circle(im, center, rr, (min(255,v),min(255,v+2),min(255,v+6),255))
    return im

def cylinder(box):
    x0,y0,x1,y1 = map(int,box)
    size=x1-x0
    t=np.linspace(0,1,size)
    v=188+62*np.exp(-((t-.36)/.27)**2)-20*t
    rgba=np.zeros((y1-y0,size,4),dtype=np.uint8)
    rgba[:,:,0]=np.clip(v,0,255); rgba[:,:,1]=np.clip(v+3,0,255); rgba[:,:,2]=np.clip(v+7,0,255)
    rgba[:,:,3]=255
    piece=Image.fromarray(rgba)
    mask=Image.new('L',piece.size); ImageDraw.Draw(mask).rounded_rectangle((0,0,size-1,y1-y0-1),radius=min(size//2,9),fill=255)
    piece.putalpha(mask)
    im=layer(); im.alpha_composite(piece,(x0,y0))
    return im

# Static plinth, pulley and physically tangent drive belt.
deck=layer(); d=ImageDraw.Draw(deck)
pu=(135,290); pr=92
vx,vy=CX-pu[0],CY-pu[1]; dist=math.hypot(vx,vy)
base=math.atan2(vy,vx); spread=math.acos((R-pr)/dist)
for angle in (base+spread,base-spread):
    nx,ny=math.cos(angle),math.sin(angle)
    a=(pu[0]-pr*nx,pu[1]-pr*ny); b=(CX-R*nx,CY-R*ny)
    d.line((a,b),fill=(112,121,134,88),width=7)
    d.line(((a[0]-2,a[1]-2),(b[0]-2,b[1]-2)),fill=(255,255,255,84),width=2)
# Shadow is baked into transparent image pixels, not a native View hit region.
plate_mask=layer(); circle(plate_mask,(CX,CY),R,(255,255,255,255))
deck.alpha_composite(shadow(plate_mask,18,(7,14),47))
pulley=metallic_disc(pu,108)
circle(pulley,pu,74,(217,222,230,255),(251,253,255,235),5)
circle(pulley,pu,53,(199,206,216,255))
circle(pulley,(pu[0]-3,pu[1]-4),36,(248,250,252,255),(231,235,240,255),3)
deck.alpha_composite(shadow(pulley,11,(5,9),42)); deck.alpha_composite(pulley)
save_asset(deck, 'deck.png')

# High-resolution white vinyl. Dense shallow grooves are rasterized once.
D=1560
y,x=np.mgrid[:D,:D]; rx=x-(D-1)/2; ry=y-(D-1)/2; radial=np.sqrt(rx*rx+ry*ry)
light=(-rx-ry)/(D*1.5)
value=244+3*light+3*np.exp(-((radial-769)/5)**2)-5*np.exp(-((radial-776)/2)**2)
rgba=np.empty((D,D,4),dtype=np.uint8)
for c,delta in enumerate((0,1,3)): rgba[:,:,c]=np.clip(value+delta,0,255)
rgba[:,:,3]=np.clip((779.5-radial)*255,0,255)
record=Image.fromarray(rgba); rd=ImageDraw.Draw(record)
for i,rr in enumerate(range(476,749,11)):
    shade=(223,226,232,90) if i%3==0 else (229,232,237,70)
    groove=Image.new('RGBA',(D,D)); gd=ImageDraw.Draw(groove)
    gd.ellipse((780-rr,780-rr,780+rr,780+rr),outline=shade,width=2)
    gd.ellipse((782-rr,782-rr,778+rr,778+rr),outline=(255,255,255,70),width=1)
    record.alpha_composite(groove)
rd=ImageDraw.Draw(record)
rd.ellipse((312,312,1248,1248),fill=(226,230,236,255),outline=(231,235,240,255),width=5)
# The actual album image overlays the middle. Never add a spindle over the artwork.
save_asset(record, 'record.png')

# Static silver tonearm at the RIGHT, no dark block over the disc.
arm=layer(); ax=1840
pivot=metallic_disc((ax,350),94)
circle(pivot,(ax,350),66,(216,222,231,245),(248,250,253,220),4)
arm.alpha_composite(pivot)
arm.alpha_composite(cylinder((ax-11,97,ax+11,1206)))
# Counterweight above the pivot and compact mount collar.
arm.alpha_composite(cylinder((ax-69,151,ax+69,219)))
arm.alpha_composite(cylinder((ax-43,301,ax+43,380)))
# Warm needle collar is the tiny material accent from the reference.
ImageDraw.Draw(arm).rounded_rectangle((ax-20,1167,ax+20,1211),radius=4,fill=(213,125,85,255))
head=layer(); hd=ImageDraw.Draw(head)
hd.polygon([(ax-23,1211),(ax+20,1211),(ax+22,1268),(ax+117,1313),(ax+110,1335),(ax+16,1308),(ax-25,1290)],fill=(246,248,251,255))
hd.line([(ax-20,1212),(ax-22,1287),(ax+12,1304),(ax+108,1331)],fill=(203,210,221,220),width=4)
hd.line([(ax+18,1220),(ax+18,1268),(ax+108,1315)],fill=(255,255,255,255),width=4)
for p in ((ax-4,1274),(ax+22,1294)): circle(head,p,6,(78,89,105,230))
arm.alpha_composite(head)
full_arm=shadow(arm,12,(8,11),49); full_arm.alpha_composite(arm)
save_asset(full_arm, 'arm.png')

# A compact material-only preview for human review, not shipped in the app.
preview=Image.new('RGBA',(W,H),(223,227,235,255)); preview.alpha_composite(deck)
preview.alpha_composite(record,(180,170))
# Neutral sample center avoids bundling anyone else's album image.
cc=layer(); circle(cc,(CX,CY),359,(101,113,133,255))
circle(cc,(CX-97,CY-92),150,(118,133,154,255)); circle(cc,(CX+132,CY+158),180,(80,94,115,255))
preview.alpha_composite(cc); preview.alpha_composite(full_arm)
preview.convert('RGB').save(ROOT/'tools/player-turntable-preview.png',optimize=True)
for path in OUT.glob('*.png'):
    image=Image.open(path)
    assert image.mode=='RGBA'
    print(f'{path.relative_to(ROOT)}: {image.size}, {path.stat().st_size} bytes')
