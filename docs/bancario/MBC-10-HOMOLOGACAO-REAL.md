# MBC-10 — Homologação real

## TESTE MOCK

Executável sem internet. MOCK e MOCK_OPEN_FINANCE intactos. Harness injetável só em testes (não é fallback do motor).

## TESTE REAL

**NÃO HOMOLOGADO.**

Faltam: credenciais oficiais, ambiente autorizado, documentação da instituição, consentimento de teste, endpoint oficial, certificado se exigido.

Nenhum item do checklist de produção da MBC-09 foi marcado como concluído.

## Limitações explícitas

- Instituição não escolhida
- Sem OAuth/OIDC real
- Sem paginação/cursor de um banco específico
- Sem evidência de 429/timeout reais de rede
- UI não deve exibir “conectado ao banco”
- Matching de vendas/compras continua fora do MBC-04
