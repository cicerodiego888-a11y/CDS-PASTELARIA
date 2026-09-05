# MBC-11 — Seleção e homologação do primeiro provider real

Provider real ainda não homologável por ausência de documentação e ambiente oficial.

## Identificação

| Campo | Valor |
|---|---|
| PROVIDER | OPEN_FINANCE_REAL (código interno) — instituição **não escolhida** |
| INSTITUIÇÃO | — |
| AMBIENTE | SANDBOX / HOMOLOGACAO / PRODUCAO (separados na config) |
| DOCUMENTAÇÃO OFICIAL | — |
| URLS OFICIAIS | — |

## Classificação

**PROVIDER REAL PREPARADO, MAS NÃO IMPLEMENTADO.**

Não assumir banco. Não inventar API, endpoint, OAuth, certificado, payload ou escopo.

## O que esta sprint fez

- Matriz de compatibilidade (todos PENDENTE)
- Separação de ambiente (produção ≠ sandbox)
- Metadados não secretos `aplicacao_ref` / `config_ref` em `config_integracao_bancaria`
- Recusa de credencial no body da configuração
- UI: “ainda não homologável”
- 70+ testes offline

## O que não foi feito

- Integração HTTP com instituição
- Autorização/callback/saldo/extrato reais
- Homologação visual no navegador contra banco
