# Release Certification Report — RC4.32.0

## Ambiente

- Versão: 1.0.3
- Commit: 8f01f31
- Build: 2026-08-12T18:34:36.036Z
- Hash app.asar: `d257316ebbe89e210cb6f3744e32f430b8566969ab1d119a55e09c6b708b494d`
- Origem: instalador-desatualizado
- Data: 2026-08-15T12:24:25.618Z

## Resultados

✔ Inicialização do ERP
  - DB ok | pacote: instalador-desatualizado | asar: d257316ebbe8…
✔ Login
  - user=rc4320_1786796664102 perfil=SUPER_ADMIN
✔ Cadastro de Produtos
  - CRUD ok | embalagem CX×12 | codigo=RC4320-1786796662620-P
✔ Compras
  - NF-e …00000064 | status=EM_REVISAO
✔ Financeiro
  - parser financeiro OK | parcela R$500 | registros financeiro=67
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
  - compras=1 fin=67 prod=684
✔ Performance
  - 3s | mem 27.8MB | sql=16

## Estatísticas

- Tempo total: 3s
- Memória máxima: 27.8 MB
- CPU user: 2031 ms
- Testes/etapas: 12
- Exceções: 0
- Consultas SQL: 16
- Cobertura funcional: 100%

## Status da Release

**APROVADA**
