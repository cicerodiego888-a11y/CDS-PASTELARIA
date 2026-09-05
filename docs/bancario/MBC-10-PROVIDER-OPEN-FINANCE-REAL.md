# MBC-10 — Provider Open Finance real

**PROVIDER:** OPEN_FINANCE_REAL  
**INSTITUIÇÃO:** NÃO DEFINIDA  
**AMBIENTE:** SANDBOX / HOMOLOGAÇÃO / PRODUÇÃO (configuráveis). Oficial: **indisponível**.  
**DOCUMENTAÇÃO OFICIAL:** NÃO DISPONÍVEL neste repositório/ambiente.

Classificação (seção 41): **PROVIDER REAL PREPARADO, MAS NÃO IMPLEMENTADO.**

Não há contrato técnico oficial de instituição, credencial, certificado nem endpoint autorizado. Esta sprint **não inventa** API de banco.

## Adapter

`backend/motores/bancario/providers/openfinance-real/`

- `OpenFinanceRealBankProvider.js` — implementa `IBankProvider`
- `OpenFinanceRealClient.js` — HTTP com timeout; recusa rede sem habilitação oficial
- `OpenFinanceRealMapper.js` — normaliza conta/saldo/extrato/paginação
- `OpenFinanceRealConstants.js` — código, timeouts, chaves conceituais
- `retrySeguro.js` — retry só para timeout / 429 / indisponibilidade

Habilitação oficial (todas obrigatórias):

- `MBC_OF_REAL_HABILITADO=1`
- `MBC_OF_REAL_AUTH_URL`
- `MBC_OF_REAL_TOKEN_URL`
- `MBC_OF_REAL_API_URL`

Sem isso, `disponivel === false` e as operações reais falham com `PROVIDER_NAO_EXECUTAVEL`.

## Registry

`MOCK` · `MOCK_OPEN_FINANCE` · `OPEN_FINANCE_REAL`

O núcleo resolve pelo Registry. Sem `if provider ===` nas rotas.

## Configuração

Continua em `config_integracao_bancaria` (empresa + conta). Sem tabela paralela.  
Provider real: SANDBOX, HOMOLOGACAO ou PRODUCAO. Não usa TESTE (reservado ao MOCK).
