# Auditoria de Integridade — Pós-atualizações

**Resultado: INTEGRIDADE COM FALHAS**

- Gerado em: 2026-10-22T01:11:42.122Z
- Checks OK: 77 | Fail: 0
- Suites: 6/11
- Warnings: 1

## Suites
- ✖ **mib-rc10** (1033ms) exit=1
- ✔ **mib-rc11** (1576ms) exit=0
- ✖ **mib-rc20** (985ms) exit=1
- ✖ **mib-rc30** (909ms) exit=1
- ✖ **mib-rc40** (4457ms) exit=1
- ✔ **cip-rc10** (1846ms) exit=0
- ✔ **cia-rc10** (2237ms) exit=0
- ✔ **cia-apps-rc10** (1922ms) exit=0
- ✔ **smart-dashboard** (2048ms) exit=0
- ✔ **business-monitor** (2972ms) exit=0
- ✖ **stable-10** (449ms) exit=1

## Warnings
- enterprise.sql: BaseSqlProvider ainda usa LOWER/REPLACE (fora do hot-path PDV)

## Falhas
- suite:mib-rc10: log\AtomicCatalog.js:92:15
    at new Promise (<anonymous>)
    at AtomicCatalog.rebuild (C:\projetos\CDS-SISTEMAS PASTELARIA\backend\motores\mib\catalog\AtomicCatalog.js:91:12)
    at AtomicCatalog.garantir (C:\projetos\CDS-SISTEMAS PASTELARIA\backend\motores\mib\catalog\AtomicCatalog.js:170:17)
  
- suite:mib-rc20: AtomicCatalog.js:92:15
    at new Promise (<anonymous>)
    at AtomicCatalog.rebuild (C:\projetos\CDS-SISTEMAS PASTELARIA\backend\motores\mib\catalog\AtomicCatalog.js:91:12)
    at AtomicCatalog.garantir (C:\projetos\CDS-SISTEMAS PASTELARIA\backend\motores\mib\catalog\AtomicCatalog.js:170:17)
    at
- suite:mib-rc30: omicCatalog.js:92:15
    at new Promise (<anonymous>)
    at AtomicCatalog.rebuild (C:\projetos\CDS-SISTEMAS PASTELARIA\backend\motores\mib\catalog\AtomicCatalog.js:91:12)
    at AtomicCatalog.garantir (C:\projetos\CDS-SISTEMAS PASTELARIA\backend\motores\mib\catalog\AtomicCatalog.js:170:17)
    at C
- suite:mib-rc40: CDS-SISTEMAS PASTELARIA\backend\motores\mib\catalog\AtomicCatalog.js:91:12)
    at AtomicCatalog.garantir (C:\projetos\CDS-SISTEMAS PASTELARIA\backend\motores\mib\catalog\AtomicCatalog.js:170:17)
    at CatalogMemory.garantir (C:\projetos\CDS-SISTEMAS PASTELARIA\backend\motores\mib\catalog\CatalogMe
- suite:stable-10: us>)
    at AtomicCatalog.rebuild (C:\projetos\CDS-SISTEMAS PASTELARIA\backend\motores\mib\catalog\AtomicCatalog.js:91:12)
    at AtomicCatalog.garantir (C:\projetos\CDS-SISTEMAS PASTELARIA\backend\motores\mib\catalog\AtomicCatalog.js:170:17)
    at CatalogMemory.garantir (C:\projetos\CDS-SISTEMAS P

## Escopo verificado
- Motores: MIB, CIP, CIA
- Plugins: 5 copilotos + smart-dashboard + business-monitor
- APIs: /api/search, /intelligence, /agent, /plugins, /business-monitor
- UI ERP/PDV + painéis plugin
- STABLE-1.0 certificação
