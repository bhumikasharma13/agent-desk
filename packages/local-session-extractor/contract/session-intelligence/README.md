# Session Intelligence's `Conversation`, as a descriptor

`conversation.binpb` is a protobuf `FileDescriptorSet` of `proto/sessionintelligence/v1/conversation.proto`
and its imports, from [Session Intelligence](https://github.com/tetriz-ai/session-intelligence) at
commit `aebbc1d4f763ddb0f8d44a7a7dc9704e858653ce`. `src/__tests__/sessionIntelligenceContract.test.ts`
parses every converted fixture session against it, with unknown fields and enum names refused. It is
a test input only and is not in the published package.

The proto imports `buf/validate/validate.proto`, taken from the `buf.build/bufbuild/protovalidate`
commit that Session Intelligence's `go.mod` pins. That file is from [protovalidate](https://github.com/bufbuild/protovalidate),
Copyright Buf Technologies, Inc., licensed under the Apache License 2.0; its text is in [LICENSE-protovalidate](LICENSE-protovalidate). To regenerate it, with `git`, `buf` and `protoc`
installed, from this folder:

```sh
work="$(mktemp -d)"
git clone https://github.com/tetriz-ai/session-intelligence "$work/si"
git -C "$work/si" checkout aebbc1d4f763ddb0f8d44a7a7dc9704e858653ce
buf export buf.build/bufbuild/protovalidate:80ab13bee0bf4272b6161a72bf7034e0 -o "$work/deps"
protoc -I "$work/si/proto" -I "$work/deps" --include_imports \
  --descriptor_set_out=conversation.binpb sessionintelligence/v1/conversation.proto
```

To follow a newer Session Intelligence, check out its commit, take the protovalidate commit from its
`go.mod`, update both ids here and in `docs/reference.md`, and run the contract test.
