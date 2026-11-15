use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use medha_core::signing::{
    canonical_json, episode_id_for_value, key_id_for, signable_value, signing_payload_for_value,
    verify_episode_value, KeyRecord, KeyRole, Keyring, VerifyOutcome,
};
use serde_json::Value;

fn decode_hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex"))
        .collect()
}

#[test]
fn test_signing_vectors_conformance() {
    let raw_spec = include_str!("../../../docs/spec/vectors/signing.json");
    let spec: Value = serde_json::from_str(raw_spec).expect("valid signing.json");

    let seed_hex = spec["key"]["seedHex"].as_str().expect("seedHex");
    let expected_pubkey = spec["key"]["publicKey"].as_str().expect("publicKey");
    let expected_key_id = spec["key"]["keyId"].as_str().expect("keyId");

    // Check keyId derivation
    let derived_key_id = key_id_for(expected_pubkey).expect("derived keyId");
    assert_eq!(derived_key_id, expected_key_id);

    // Derive keypair from seed
    let seed_bytes = decode_hex(seed_hex);
    let mut seed_arr = [0u8; 32];
    seed_arr.copy_from_slice(&seed_bytes);
    let signing_key = SigningKey::from_bytes(&seed_arr);
    let verifying_key = signing_key.verifying_key();
    let actual_pubkey = URL_SAFE_NO_PAD.encode(verifying_key.as_bytes());
    assert_eq!(actual_pubkey, expected_pubkey);

    let cases = spec["cases"].as_array().expect("cases");
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let episode = &case["episode"];
        let expected_canonical = case["canonical"].as_str().unwrap();
        let expected_episode_id = case["episodeId"].as_str().unwrap();
        let expected_sig = &case["sig"];

        // 1. Canonical JSON representation
        let signable = signable_value(episode);
        let actual_canonical = canonical_json(&signable).expect("canonical json");
        assert_eq!(
            actual_canonical, expected_canonical,
            "canonical JSON mismatch for case '{}'",
            name
        );

        // 2. Episode ID
        let actual_episode_id = episode_id_for_value(episode).expect("episode id");
        assert_eq!(
            actual_episode_id, expected_episode_id,
            "episodeId mismatch for case '{}'",
            name
        );

        // 3. Signing payload & signature generation
        let payload = signing_payload_for_value(episode).expect("payload");
        let sig = signing_key.sign(&payload);
        let sig_str = URL_SAFE_NO_PAD.encode(sig.to_bytes());
        assert_eq!(
            sig_str,
            expected_sig["value"].as_str().unwrap(),
            "signature mismatch for case '{}'",
            name
        );

        let principal = episode["author"]
            .as_str()
            .unwrap()
            .split('/')
            .next()
            .unwrap()
            .to_string();

        let keyring = Keyring {
            version: 1,
            keys: vec![KeyRecord {
                key_id: expected_key_id.to_string(),
                public_key: expected_pubkey.to_string(),
                principal: principal.clone(),
                roles: vec![KeyRole::Agent, KeyRole::Human, KeyRole::Maintainer],
                namespaces: None,
                valid_from: None,
                valid_until: None,
                revoked: None,
                supersedes: None,
                comment: None,
            }],
        };

        // 4. Verification of signed episode
        let mut signed_episode = episode.clone();
        signed_episode["sig"] = expected_sig.clone();
        let outcome = verify_episode_value(&signed_episode, &keyring);
        assert_eq!(
            outcome,
            VerifyOutcome::Verified {
                key_id: expected_key_id.to_string(),
                principal,
            },
            "verification failed for case '{}'",
            name
        );
    }

    // 5. Negative and policy cases
    let base_episode = &cases[0]["episode"];
    let base_sig = &cases[0]["sig"];
    let mut ep = base_episode.clone();
    ep["sig"] = base_sig.clone();

    // Wrong principal
    let keyring_wrong_principal = Keyring {
        version: 1,
        keys: vec![KeyRecord {
            key_id: expected_key_id.to_string(),
            public_key: expected_pubkey.to_string(),
            principal: "agent:other".to_string(),
            roles: vec![KeyRole::Agent],
            namespaces: None,
            valid_from: None,
            valid_until: None,
            revoked: None,
            supersedes: None,
            comment: None,
        }],
    };
    match verify_episode_value(&ep, &keyring_wrong_principal) {
        VerifyOutcome::Invalid { reason, .. } => {
            assert!(reason.contains("is not principal"));
        }
        other => panic!("expected invalid, got {:?}", other),
    }

    // Missing human role for human author
    let mut ep_human = ep.clone();
    ep_human["author"] = Value::String("human:alice".to_string());
    // Re-sign with signing key
    let payload_human = signing_payload_for_value(&ep_human).unwrap();
    let sig_human = signing_key.sign(&payload_human);
    ep_human["sig"]["value"] = Value::String(URL_SAFE_NO_PAD.encode(sig_human.to_bytes()));

    let keyring_no_human = Keyring {
        version: 1,
        keys: vec![KeyRecord {
            key_id: expected_key_id.to_string(),
            public_key: expected_pubkey.to_string(),
            principal: "human:alice".to_string(),
            roles: vec![KeyRole::Agent], // Missing human
            namespaces: None,
            valid_from: None,
            valid_until: None,
            revoked: None,
            supersedes: None,
            comment: None,
        }],
    };
    match verify_episode_value(&ep_human, &keyring_no_human) {
        VerifyOutcome::Invalid { reason, .. } => {
            assert!(reason.contains("needs a key with the human role"));
        }
        other => panic!("expected invalid, got {:?}", other),
    }

    // Namespace outside scope
    let keyring_ns_scope = Keyring {
        version: 1,
        keys: vec![KeyRecord {
            key_id: expected_key_id.to_string(),
            public_key: expected_pubkey.to_string(),
            principal: "agent:ci".to_string(),
            roles: vec![KeyRole::Agent],
            namespaces: Some(vec!["team-b".to_string()]), // ep has "team-a"
            valid_from: None,
            valid_until: None,
            revoked: None,
            supersedes: None,
            comment: None,
        }],
    };
    match verify_episode_value(&ep, &keyring_ns_scope) {
        VerifyOutcome::Invalid { reason, .. } => {
            assert!(reason.contains("outside the key's scope"));
        }
        other => panic!("expected invalid, got {:?}", other),
    }

    // Revocation without trustBefore
    let keyring_revoked = Keyring {
        version: 1,
        keys: vec![KeyRecord {
            key_id: expected_key_id.to_string(),
            public_key: expected_pubkey.to_string(),
            principal: "agent:ci".to_string(),
            roles: vec![KeyRole::Agent],
            namespaces: None,
            valid_from: None,
            valid_until: None,
            revoked: Some(medha_core::signing::KeyRevocation {
                at: 1790000000000,
                reason: "compromised".to_string(),
                trust_before: None,
            }),
            supersedes: None,
            comment: None,
        }],
    };
    match verify_episode_value(&ep, &keyring_revoked) {
        VerifyOutcome::Invalid { reason, .. } => {
            assert_eq!(reason, "key revoked");
        }
        other => panic!("expected invalid, got {:?}", other),
    }

    // Revocation with trustBefore
    let keyring_revoked_with_trust = Keyring {
        version: 1,
        keys: vec![KeyRecord {
            key_id: expected_key_id.to_string(),
            public_key: expected_pubkey.to_string(),
            principal: "agent:ci".to_string(),
            roles: vec![KeyRole::Agent],
            namespaces: None,
            valid_from: None,
            valid_until: None,
            revoked: Some(medha_core::signing::KeyRevocation {
                at: 1790000000000,
                reason: "compromised".to_string(),
                trust_before: Some(1790000000001), // after ep.at
            }),
            supersedes: None,
            comment: None,
        }],
    };
    match verify_episode_value(&ep, &keyring_revoked_with_trust) {
        VerifyOutcome::Verified { .. } => {}
        other => panic!("expected verified, got {:?}", other),
    }
}
