# Release Certification Report — RC4.32.0

## Ambiente

- Versão: 1.0.3
- Commit: 694fb39
- Build: 2026-11-16T10:37:28.934Z
- Hash app.asar: `49f5f7c7025c2500cebe468739895426f0d69bf8b5baa4d0758413fc629c15aa`
- Origem: fonte
- Data: 2026-11-19T18:25:33.673Z

## Resultados

✔ Inicialização do ERP
  - DB ok | pacote: fonte | asar: N/A…
✔ Login
  - user=rc4320_1795112732430 perfil=SUPER_ADMIN
✔ Cadastro de Produtos
  - CRUD ok | embalagem CX×12 | codigo=RC4320-1795112729424-P
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
  - 4.2s | mem 32.6MB | sql=16

## Estatísticas

- Tempo total: 4.3s
- Memória máxima: 32.6 MB
- CPU user: 1469 ms
- Testes/etapas: 12
- Exceções: 0
- Consultas SQL: 16
- Cobertura funcional: 100%

## Status da Release

**APROVADA**
