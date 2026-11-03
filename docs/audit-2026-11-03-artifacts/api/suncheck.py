import os as _os, sys as _sys
_FASTAPI = _os.path.normpath(_os.path.join(_os.path.dirname(_os.path.abspath(__file__)), '..', '..', '..', 'FastAPI'))
_sys.path.insert(0, _FASTAPI); _sys.path.insert(0, _os.path.join(_FASTAPI, 'scripts'))
# Independent sunrise/sunset: NOAA solar calculator (spreadsheet) equations.
import math, json, sys
from datetime import date, timedelta
from api.astronomy import sunrise_sunset_utc
LAT, LON, TZ = 48.65, -122.85, -7
def noaa(d, lat, lon, tz):
    # Julian day at local noon
    jd = d.toordinal() + 1721424.5 + 0.5 - tz/24
    jc = (jd - 2451545)/36525
    gml = (280.46646 + jc*(36000.76983 + jc*0.0003032)) % 360
    gma = 357.52911 + jc*(35999.05029 - 0.0001537*jc)
    ecc = 0.016708634 - jc*(0.000042037 + 0.0000001267*jc)
    seoc = (math.sin(math.radians(gma))*(1.914602 - jc*(0.004817+0.000014*jc)) + math.sin(math.radians(2*gma))*(0.019993-0.000101*jc) + math.sin(math.radians(3*gma))*0.000289)
    stl = gml + seoc
    sal = stl - 0.00569 - 0.00478*math.sin(math.radians(125.04 - 1934.136*jc))
    moe = 23 + (26 + ((21.448 - jc*(46.815 + jc*(0.00059 - jc*0.001813))))/60)/60
    oc = moe + 0.00256*math.cos(math.radians(125.04 - 1934.136*jc))
    decl = math.degrees(math.asin(math.sin(math.radians(oc))*math.sin(math.radians(sal))))
    y = math.tan(math.radians(oc/2))**2
    eot = 4*math.degrees(y*math.sin(2*math.radians(gml)) - 2*ecc*math.sin(math.radians(gma)) + 4*ecc*y*math.sin(math.radians(gma))*math.cos(2*math.radians(gml)) - 0.5*y*y*math.sin(4*math.radians(gml)) - 1.25*ecc*ecc*math.sin(2*math.radians(gma)))
    ha = math.degrees(math.acos(math.cos(math.radians(90.833))/(math.cos(math.radians(lat))*math.cos(math.radians(decl))) - math.tan(math.radians(lat))*math.tan(math.radians(decl))))
    noon = (720 - 4*lon - eot + tz*60)/1440
    rise = noon - ha*4/1440
    sett = noon + ha*4/1440
    return rise*24, sett*24
def fmt(h):
    hh=int(h); mm=int(round((h-hh)*60))
    if mm==60: hh+=1; mm=0
    return f"{hh:02d}:{mm:02d}"
live = json.load(open('./live/suntimes.json'))['data']
d = date(2021,5,27); maxdiff=0
while d <= date(2021,6,18):
    r_u, s_u = sunrise_sunset_utc(d, LAT, LON)
    app_r, app_s = (r_u+TZ)%24, (s_u+TZ)%24
    n_r, n_s = noaa(d, LAT, LON, TZ)
    k = d.isoformat()
    dr = (app_r-n_r)*60; ds=(app_s-n_s)*60
    maxdiff=max(maxdiff,abs(dr),abs(ds))
    print(k, 'app', fmt(app_r), fmt(app_s), 'noaa', fmt(n_r), fmt(n_s), 'live', live[k], f'diff(min) {dr:+.1f} {ds:+.1f}')
    d += timedelta(days=1)
print('max abs diff minutes', round(maxdiff,1))
