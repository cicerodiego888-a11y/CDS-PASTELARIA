# MBC-13 — Checklist de onboarding do provider

Preencher **somente** com dados da documentação oficial. Segredos: registrar apenas CONFIGURADO / NÃO CONFIGURADO.

## IDENTIFICAÇÃO

- Nome da instituição:
- Nome do provider:
- Código interno: `OPEN_FINANCE_REAL` (já reservado)
- Produto Open Finance:
- Ambiente: SANDBOX / HOMOLOGAÇÃO / PRODUÇÃO
- Responsável técnico:
- Documentação oficial (URL):
- Data da validação:

## AUTENTICAÇÃO

- Método:
- OAuth: SIM / NÃO / NÃO INFORMADO
- Client ID: NÃO CONFIGURADO
- Client Secret: NÃO CONFIGURADO
- Certificado: NÃO CONFIGURADO
- mTLS: NÃO INFORMADO
- Redirect URI:
- Scopes:

## AMBIENTE (um bloco por ambiente)

### SANDBOX

- endpoint conhecido? NÃO
- certificado conhecido? NÃO
- credencial disponível? NÃO
- OAuth disponível? NÃO
- conta disponível? NÃO
- saldo disponível? NÃO
- extrato disponível? NÃO

### HOMOLOGAÇÃO

- endpoint conhecido? NÃO
- certificado conhecido? NÃO
- credencial disponível? NÃO
- OAuth disponível? NÃO
- conta disponível? NÃO
- saldo disponível? NÃO
- extrato disponível? NÃO

### PRODUÇÃO

- endpoint conhecido? NÃO
- certificado conhecido? NÃO
- credencial disponível? NÃO
- OAuth disponível? NÃO
- conta disponível? NÃO
- saldo disponível? NÃO
- extrato disponível? NÃO

Situação atual de todos os ambientes: **BLOQUEADO** (sem contrato oficial).

## DADOS

- Identificação de conta oficial:
- Consulta de saldo oficial:
- Consulta de transações oficial:
- Paginação oficial:
- Cursor oficial (opaco no MBC):
- Rate limit oficial:
- Códigos de erro oficiais:
- Política de retry oficial:

## SEGURANÇA / PRODUÇÃO

- SecretStore de produção (Vault/HSM/Secret Manager): NÃO CONFIGURADO
- Feature flag `MBC_OPEN_FINANCE_REAL_ENABLED`: false
- Operação assistida concluída? NÃO
- Aprovação final: NÃO
