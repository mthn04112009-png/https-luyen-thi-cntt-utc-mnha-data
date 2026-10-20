from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import PP_ALIGN
from lxml import etree
from PIL import Image, ImageDraw
import copy

# ảnh thử
im = Image.new('RGB', (300, 200), (30, 120, 200)); d = ImageDraw.Draw(im); d.ellipse((50, 30, 250, 170), fill=(255, 200, 0)); im.save('/tmp/pic.png')

prs = Presentation()   # 4:3 mặc định 9144000x6858000
# Slide 1: layout tiêu đề (placeholder kế thừa từ layout)
s1 = prs.slides.add_slide(prs.slide_layouts[0])
s1.shapes.title.text = 'Xin chào PPTX'
s1.placeholders[1].text = 'Phụ đề kế thừa vị trí từ layout'

# Slide 2: tiêu đề + nội dung bullet + hình + ảnh + bảng + nhóm
s2 = prs.slides.add_slide(prs.slide_layouts[1])
s2.shapes.title.text = 'Nội dung & hình'
tf = s2.placeholders[1].text_frame
tf.text = 'Gạch đầu dòng một'
p = tf.add_paragraph(); p.text = 'Gạch đầu dòng hai'; p.level = 1
p = tf.add_paragraph(); p.text = 'Gạch đầu dòng ba'
s2.placeholders[1].left, s2.placeholders[1].top, s2.placeholders[1].width, s2.placeholders[1].height = Inches(0.5), Inches(1.5), Inches(4.2), Inches(2.5)
box = s2.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(5), Inches(1.5), Inches(2.5), Inches(1.2))
box.fill.solid(); box.fill.fore_color.rgb = RGBColor(0xE9, 0x4F, 0x37); box.text_frame.text = 'Bo góc'
box.text_frame.paragraphs[0].runs[0].font.size = Pt(24); box.text_frame.paragraphs[0].runs[0].font.bold = True
ell = s2.shapes.add_shape(MSO_SHAPE.OVAL, Inches(5.2), Inches(3), Inches(1.4), Inches(1.4))   # fill theo style
tri = s2.shapes.add_shape(MSO_SHAPE.ISOSCELES_TRIANGLE, Inches(7), Inches(3), Inches(1.4), Inches(1.4)); tri.rotation = 20
s2.shapes.add_picture('/tmp/pic.png', Inches(0.5), Inches(4.3), Inches(3), Inches(2))
tbl = s2.shapes.add_table(3, 3, Inches(4), Inches(4.5), Inches(5), Inches(1.5)).table
for r in range(3):
    for c in range(3): tbl.cell(r, c).text = f'R{r}C{c}'
grp = s2.shapes.add_group_shape()
g1 = grp.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(8), Inches(0.3), Inches(1), Inches(0.5))
g2 = grp.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(8.4), Inches(0.5), Inches(0.5), Inches(0.5))

# Slide 3: hiệu ứng + chuyển cảnh
s3 = prs.slides.add_slide(prs.slide_layouts[6])
A = s3.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(1), Inches(1), Inches(2), Inches(1)); A.text_frame.text = 'A: Fade (click 1)'
B = s3.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(1), Inches(2.5), Inches(2), Inches(1)); B.text_frame.text = 'B: Fly in từ trái (click 2)'
C = s3.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(1), Inches(4), Inches(2), Inches(1)); C.text_frame.text = 'C: Wipe (cùng B)'
D = s3.shapes.add_shape(MSO_SHAPE.OVAL, Inches(5), Inches(1), Inches(1.5), Inches(1.5)); D.text_frame.text = 'D'
E = s3.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(5), Inches(3), Inches(2), Inches(1)); E.text_frame.text = 'E: Exit fade (click 3)'
txt = s3.shapes.add_textbox(Inches(1), Inches(5.5), Inches(6), Inches(1.5))
txt.text_frame.text = 'Đoạn 1'; txt.text_frame.add_paragraph().text = 'Đoạn 2'; txt.text_frame.add_paragraph().text = 'Đoạn 3'
ids = {n: sh.shape_id for n, sh in dict(A=A, B=B, C=C, D=D, E=E, T=txt).items()}
print(ids)

P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
def eff(spid, cls, preset, sub, node, delay=0, dur=500, para=None, extra=''):
    tgt = f'<p:spTgt spid="{spid}">' + (f'<p:txEl><p:pRg st="{para}" end="{para}"/></p:txEl>' if para is not None else '') + '</p:spTgt>'
    beh = ''
    if cls == 'entr' and preset == 1:
        beh = f'<p:set><p:cBhvr><p:cTn id="9" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn><p:tgtEl>{tgt}</p:tgtEl><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set>'
    else:
        vis = 'visible' if cls == 'entr' else 'hidden'
        beh = (f'<p:set><p:cBhvr><p:cTn id="9" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn><p:tgtEl>{tgt}</p:tgtEl><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="{vis}"/></p:to></p:set>'
               f'<p:animEffect transition="{"in" if cls=="entr" else "out"}" filter="fade"><p:cBhvr><p:cTn id="10" dur="{dur}"/><p:tgtEl>{tgt}</p:tgtEl></p:cBhvr></p:animEffect>')
    beh += extra
    return (f'<p:par><p:cTn id="5" presetID="{preset}" presetClass="{cls}" presetSubtype="{sub}" fill="hold" nodeType="{node}">'
            f'<p:stCondLst><p:cond delay="{delay}"/></p:stCondLst><p:childTnLst>{beh}</p:childTnLst></p:cTn></p:par>')
def group(effs, delay=0):
    return f'<p:par><p:cTn id="4" fill="hold"><p:stCondLst><p:cond delay="{delay}"/></p:stCondLst><p:childTnLst>{"".join(effs)}</p:childTnLst></p:cTn></p:par>'
def step(groups):
    return f'<p:par><p:cTn id="3" fill="hold"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst><p:childTnLst>{"".join(groups)}</p:childTnLst></p:cTn></p:par>'

steps = [
  step([group([eff(ids['A'], 'entr', 10, 0, 'clickEffect', 0, 500)])]),
  step([group([eff(ids['B'], 'entr', 2, 8, 'clickEffect', 0, 700), eff(ids['C'], 'entr', 22, 8, 'withEffect', 200, 600)]),
        group([eff(ids['D'], 'entr', 23, 0, 'afterEffect', 0, 400)], delay=700)]),
  step([group([eff(ids['E'], 'exit', 10, 0, 'clickEffect', 0, 400)])]),
  step([group([eff(ids['T'], 'entr', 10, 0, 'clickEffect', 0, 300, para=0)])]),
  step([group([eff(ids['T'], 'entr', 10, 0, 'clickEffect', 0, 300, para=1)])]),
]
timing = (f'<p:timing xmlns:p="{P}"><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>'
          f'<p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>{"".join(steps)}</p:childTnLst></p:cTn>'
          f'<p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>')
s3._element.append(etree.fromstring(timing))

def add_transition(slide, inner, attrs=''):
    t = etree.fromstring(f'<p:transition xmlns:p="{P}" {attrs}>{inner}</p:transition>')
    el = slide._element
    # transition phải đứng trước p:timing
    tm = el.find(f'{{{P}}}timing')
    if tm is not None: tm.addprevious(t)
    else: el.append(t)
add_transition(s2, '<p:push dir="u"/>', 'spd="med"')
add_transition(s3, '<p:wipe dir="r"/>', 'spd="slow" advTm="3000"')

# Slide 4: hiệu ứng chạy tự động + motion path; chuyển cảnh fade
s4 = prs.slides.add_slide(prs.slide_layouts[6])
M = s4.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(1), Inches(1), Inches(1.5), Inches(1)); M.text_frame.text = 'Path'
S = s4.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(1), Inches(3), Inches(1.5), Inches(1)); S.text_frame.text = 'Spin'
path_beh = (f'<p:animMotion origin="layout" path="M 0 0 L 0.4 0.1 E" pathEditMode="relative"><p:cBhvr><p:cTn id="11" dur="1000" fill="hold"/><p:tgtEl><p:spTgt spid="{M.shape_id}"/></p:tgtEl></p:cBhvr></p:animMotion>')
spin_beh = (f'<p:animRot by="21600000"><p:cBhvr><p:cTn id="12" dur="800" fill="hold"/><p:tgtEl><p:spTgt spid="{S.shape_id}"/></p:tgtEl></p:cBhvr></p:animRot>')
e1 = (f'<p:par><p:cTn id="5" presetID="0" presetClass="path" presetSubtype="0" fill="hold" nodeType="clickEffect"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>{path_beh}</p:childTnLst></p:cTn></p:par>')
e2 = (f'<p:par><p:cTn id="6" presetID="8" presetClass="emph" presetSubtype="0" fill="hold" nodeType="clickEffect"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>{spin_beh}</p:childTnLst></p:cTn></p:par>')
steps4 = [step([group([e1])]), step([group([e2])])]
timing4 = (f'<p:timing xmlns:p="{P}"><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>'
          f'<p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>{"".join(steps4)}</p:childTnLst></p:cTn>'
          f'</p:seq></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>')
s4._element.append(etree.fromstring(timing4))
# chuyển cảnh trong mc:AlternateContent (kiểu PowerPoint 2010+): Choice p14 + Fallback chuẩn
MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006'; P14 = 'http://schemas.microsoft.com/office/powerpoint/2010/main'
alt = etree.fromstring(f'<mc:AlternateContent xmlns:mc="{MC}" xmlns:p="{P}" xmlns:p14="{P14}"><mc:Choice Requires="p14"><p:transition spd="slow" p14:dur="1200"><p14:vortex dir="r"/></p:transition></mc:Choice><mc:Fallback><p:transition spd="slow"><p:fade/></p:transition></mc:Fallback></mc:AlternateContent>')
s4._element.find(f'{{{P}}}timing').addprevious(alt)

prs.save(__import__('os').path.join(__import__('os').path.dirname(__file__), 'deck.pptx'))
print('saved')
