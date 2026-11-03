import json, urllib.request, urllib.parse, sys
BASE='https://metatrace.uw.edu/api'
def get(path):
    with urllib.request.urlopen(BASE+path, timeout=60) as r:
        return json.load(r)
root='Archaea'
kids=[c['annotation_id'] for c in get('/taxonomy/children?parent='+urllib.parse.quote(root))['data']]
def series(aid):
    d=get('/series/annotations?source=taxonomy&annotation_id='+urllib.parse.quote(aid)+'&page_size=500')['data']
    return {r['sample']:(r['egc'],r['norm_egc']) for r in d}
rs=series(root)
ks={k:series(k) for k in kids}
print('root samples',len(rs)); 
for k,v in ks.items(): print(' ',k,len(v))
mins=[];minn=[];resid=[]
for s,(e,n) in rs.items():
    se=sum(ks[k][s][0] for k in kids if s in ks[k])
    sn=sum(ks[k][s][1] for k in kids if s in ks[k])
    mins.append(e-se); minn.append(n-sn)
print('egc residual root-sum(children): min %.6g max %.6g'%(min(mins),max(mins)))
print('norm residual: min %.3e max %.3e'%(min(minn),max(minn)))
print('any negative egc',any(x<0 for x in mins),'any negative norm',any(x<0 for x in minn))
print('count exact zero egc',sum(1 for x in mins if x==0),'of',len(mins))
