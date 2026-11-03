
import sys, os, numpy as np
sys.path.insert(0, r"E:\workspace\FPGA_Comp\nn")
import extract_events as E
root=r"E:\workspace\FPGA_Comp\row_datas\原始采集数据"
files={
 "211950": os.path.join(root,"动作三 横向移动手掌","retina-events-20261029-211950.csv"),
 "212036": os.path.join(root,"动作三 横向移动手掌","retina-events-20261029-212036.csv"),
 "204439": os.path.join(root,"动作一 从握拳到张开手掌（手心朝向摄像头）","参数搭配三 事件补录","retina-events-20261029-204439.csv"),
}
for k,p in files.items():
 s=E.load_session(p,1,3,18,0); fc=s.frame_counts.astype(float)
 print("==",k,"frames",len(fc),"span",s.span_ms)
 for th in (60,120,500):
  act=fc>=th
  cx=[];cy=[];ftv=[]
  for t,c in zip(s.frame_times,fc):
   if c<th: continue
   m=s.t==t
   cx.append(float(s.x[m].mean()));cy.append(float(s.y[m].mean()));ftv.append(int(t))
  cx=np.array(cx);cy=np.array(cy);ftv=np.array(ftv)
  tt=(ftv-ftv[0])/1000.0
  co=np.polyfit(tt,cx,1); detr=cx-np.polyval(co,tt)
  co2=np.polyfit(tt,cy,1); detry=cy-np.polyval(co2,tt)
  sm=np.convolve(detr,np.ones(3)/3,"same")
  sg=np.sign(sm); z=int(np.sum(sg[1:]!=sg[:-1]))
  print(" th",th,"n",len(cx),"spans",round((ftv[-1]-ftv[0])/1000,3),"ratio",round(len(cx)/len(fc),3))
  print("  x ptp",round(float(np.ptp(cx)),1),"detr ptp",round(float(np.ptp(detr)),1),"std",round(float(detr.std()),1),"z",z,"cyc",z/2)
  print("  y ptp",round(float(np.ptp(cy)),1),"detr ptp",round(float(np.ptp(detry)),1))
