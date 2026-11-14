# Release Certification Report — RC4.32.0

## Ambiente

- Versão: 1.0.3
- Commit: ffce987
- Build: 2026-10-26T23:16:36.101Z
- Hash app.asar: `d423470705d47d666d76aaca23c9f27a0ba34846b7fb2bbb1cb8cb60d2532247`
- Origem: fonte
- Data: 2026-11-14T11:50:06.002Z

## Resultados

✔ Inicialização do ERP
  - DB ok | pacote: fonte | asar: N/A…
✔ Login
  - user=rc4320_1794657004790 perfil=SUPER_ADMIN
✔ Cadastro de Produtos
  - CRUD ok | embalagem CX×12 | codigo=RC4320-1794657000655-P
✔ Compras
  - NF-e …00000064 | status=EM_REVISAO | empresa=1
✔ Financeiro
  - parser financeiro OK | parcela R$500 | registros financeiro=0
✔ Estoque
  - fiscal=6+3 | total=15 UN
✔ MIIP
  - MUC 10×12 → 120 UN (MULTIPLICADOR)
✔ Central Inteligente
  - documento 000064 processado
✔ NFC-e
  - homologação dest.xNome + módulo emissor presente
✔ NF-e
  - autorização cStat=100 | protocolo=123
✔ Relatórios
  - compras=0 fin=0 prod=0
✔ Performance
  - 5.3s | mem 30.7MB | sql=16

## Estatísticas

- Tempo total: 5.3s
- Memória máxima: 30.7 MB
- CPU user: 2422 ms
- Testes/etapas: 12
- Exceções: 0
- Consultas SQL: 16
- Cobertura funcional: 100%

## Status da Release

**APROVADA**
