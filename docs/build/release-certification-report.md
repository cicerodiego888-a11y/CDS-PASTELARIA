# Release Certification Report — RC4.32.0

## Ambiente

- Versão: 1.0.3
- Commit: 993ef27
- Build: 2026-09-10T00:59:35.220Z
- Hash app.asar: `1d40e36be32c906d8b2d62d656cb10ebb75686cb87f29dee24fe04c33e3e9129`
- Origem: instalador-desatualizado
- Data: 2026-09-16T23:01:49.449Z

## Resultados

✔ Inicialização do ERP
  - DB ok | pacote: instalador-desatualizado | asar: 1d40e36be32c…
✔ Login
  - user=rc4320_1789599708494 perfil=SUPER_ADMIN
✔ Cadastro de Produtos
  - CRUD ok | embalagem CX×12 | codigo=RC4320-1789599704546-P
✔ Compras
  - NF-e …00000064 | status=EM_REVISAO | empresa=1
✔ Financeiro
  - parser financeiro OK | parcela R$500 | registros financeiro=9
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
  - compras=0 fin=9 prod=44
✔ Performance
  - 4.9s | mem 27MB | sql=16

## Estatísticas

- Tempo total: 4.9s
- Memória máxima: 27.1 MB
- CPU user: 1938 ms
- Testes/etapas: 12
- Exceções: 0
- Consultas SQL: 16
- Cobertura funcional: 100%

## Status da Release

**APROVADA**
