"""Resistor selections backed by exact Yageo manufacturer specifications."""
import json
from pathlib import Path

CODES={'10k':'FR-0710KL','1M':'FR-071ML','4.7k':'FR-074K7L',
       '100k':'FR-07100KL','33':'FR-0733RL','25.5k':'FR-0725K5L',
       '0':'JR-070RL','1k':'FR-071KL','47k':'FR-0747KL','470':'FR-07470RL',
       '3.00k':'FR-073KL','100':'FR-07100RL','5.23k':'FR-075K23L',
       '30.1k':'FR-0730K1L','2.2k':'FR-072K2L','20.5k':'FR-0720K5L'}

def select(value,size):
    if size!='0603':return None
    if value=='110k 0.1%':mpn='RT0603BRD07110KL'
    elif value=='15k 0.1%':mpn='RT0603BRD0715KL'
    else:
        code=CODES.get(value.split()[0])
        if not code:return None
        mpn='RC0603'+code
    return {'mpn':mpn,'source':'https://www.yageogroup.com/component-documentation/download/specsheet/'+mpn}

if __name__=='__main__':
    from circuit import PARTS
    selected=[dict(ref=p['ref'],value=p['value'],mpn=p['mpn'],source=p['source'],dnp=p['dnp'])
              for p in PARTS if p['ref'].startswith('R') and p['source'].startswith('https://www.yageogroup.com/')]
    report={'manufacturer':'Yageo','checked_date':'2026-09-30',
            'package':'0603 / 1608 metric, nominal body 1.6 x 0.8 mm',
            'selected':selected,'count':len(selected),
            'limitations':['Availability and assembly-house sourcing not checked.',
                            'Circuit voltage/power derating and temperature remain to be qualified.',
                            'Current-sense shunts are not covered by this selection.']}
    (Path(__file__).resolve().parent.parent/'outputs/A02-RESISTOR-SELECTION.json').write_text(json.dumps(report,indent=2)+'\n')
    print('Selected',len(selected),'resistors from exact manufacturer spec sheets.')
