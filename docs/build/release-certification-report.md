# Release Certification Report — RC4.32.0

## Ambiente

- Versão: 1.0.3
- Commit: ffce987
- Build: 2026-10-26T20:18:31.474Z
- Hash app.asar: `f29c5dfa934a7aaa5070d955599d77ee6bca7e4e5fb0d0e04040f8afa95ee1ec`
- Origem: instalador-desatualizado
- Data: 2026-10-26T23:16:35.652Z

## Resultados

✔ Inicialização do ERP
  - DB ok | pacote: instalador-desatualizado | asar: f29c5dfa934a…
✔ Login
  - user=rc4320_1793056594810 perfil=SUPER_ADMIN
✔ Cadastro de Produtos
  - CRUD ok | embalagem CX×12 | codigo=RC4320-1793056590037-P
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
  - 5.6s | mem 30.8MB | sql=16

## Estatísticas

- Tempo total: 5.6s
- Memória máxima: 30.9 MB
- CPU user: 2172 ms
- Testes/etapas: 12
- Exceções: 0
- Consultas SQL: 16
- Cobertura funcional: 100%

## Status da Release

**APROVADA**
