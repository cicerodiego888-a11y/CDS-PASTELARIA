# Release Certification Report — RC4.32.0

## Ambiente

- Versão: 1.0.3
- Commit: 0d94542
- Build: 2026-08-22T15:21:11.259Z
- Hash app.asar: `213020fb5991c525440efb79f6b0b15786a326a7408ed81d336fa50922041b3a`
- Origem: instalador-desatualizado
- Data: 2026-08-22T18:51:38.852Z

## Resultados

✔ Inicialização do ERP
  - DB ok | pacote: instalador-desatualizado | asar: 213020fb5991…
✔ Login
  - user=rc4320_1787424698157 perfil=SUPER_ADMIN
✔ Cadastro de Produtos
  - CRUD ok | embalagem CX×12 | codigo=RC4320-1787424692328-P
✔ Compras
  - NF-e …00000064 | status=PRONTA_IMPORTACAO
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
  - compras=0 fin=0 prod=8
✔ Performance
  - 6.5s | mem 33.1MB | sql=16

## Estatísticas

- Tempo total: 6.5s
- Memória máxima: 33.1 MB
- CPU user: 2063 ms
- Testes/etapas: 12
- Exceções: 0
- Consultas SQL: 16
- Cobertura funcional: 100%

## Status da Release

**APROVADA**
