require "json"
require "net/http"
require "open3"
require "uri"

class AgentMaintenance < Formula
  desc "Capability-gated agent session inventory and maintenance"
  homepage "https://github.com/OWNER/agent-maintenance"
  url "https://registry.npmjs.org/agent-maintenance/-/agent-maintenance-VERSION.tgz"
  sha256 "REPLACE_WITH_RELEASE_TARBALL_SHA256"
  license "MIT"
  depends_on "node"
  depends_on "python@3.13" => :build

  def install
    libexec.install Dir["*"]
    cd libexec do
      raise "Homebrew stage did not install package.json, bin/, and dist/" unless
        File.file?("package.json") && File.directory?("bin") && File.directory?("dist")
      system "npm", "install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"
      system "npm", "rebuild", "fs-ext", "--build-from-source"
    end
    bin.install_symlink libexec/"bin/agent-maintenance.js" => "agent-maintenance"
  end

  test do
    assert_predicate libexec/"package.json", :file?
    assert_predicate libexec/"bin", :directory?
    assert_predicate libexec/"dist", :directory?
    assert_match "agent-maintenance", shell_output("#{bin}/agent-maintenance --help")
    assert_match version.to_s, shell_output("#{bin}/agent-maintenance --version")
    fixture = testpath/"codex"
    fixture.mkpath
    output = shell_output("#{bin}/agent-maintenance inventory --json --codex-home #{fixture}")
    assert_match '"sessions":[]', output
    assert_predicate libexec/"node_modules/smol-toml", :directory?
    assert_predicate libexec/"node_modules/fs-ext", :directory?

    fake_bin = testpath/"bin"
    fake_bin.mkpath
    browser = fake_bin/"chromium"
    browser.write("#!/bin/sh\nexit 0\n")
    browser.chmod 0755
    record = nil
    record_path = testpath/"home/.agent-maintenance/server.lock"
    with_env "HOME" => testpath/"home", "PATH" => "#{fake_bin}:#{ENV.fetch("PATH")}" do
      (testpath/"home").mkpath
      system bin/"agent-maintenance", "--gui"
      assert_predicate record_path, :file?
      record = JSON.parse(record_path.read)
      identity = shell_output("ps -p #{record["pid"]} -o lstart= -o command=").strip
      expected_start = record["processStartTime"]
      assert_match expected_start, identity
      assert_match "server-entry.js", identity
      uri = URI("http://127.0.0.1:#{record["port"]}/")
      request = Net::HTTP::Get.new(uri)
      request["X-Auth-Token"] = record["authToken"]
      request["X-Instance-Id"] = record["instanceId"]
      response = Net::HTTP.new(uri.host, uri.port, nil).request(request)
      assert_equal "200", response.code
      assert_match "Agent Maintenance", response.body
    ensure
      record ||= JSON.parse(record_path.read) if record_path.file?
      if record
        current, = Open3.capture2e("ps", "-p", record["pid"].to_s, "-o", "lstart=", "-o", "command=")
        current = current.strip
        if current.include?(record["processStartTime"]) && current.include?("server-entry.js")
          Process.kill("TERM", record["pid"])
          50.times do
            current, = Open3.capture2e("ps", "-p", record["pid"].to_s, "-o", "lstart=", "-o", "command=")
            break unless current.include?(record["processStartTime"]) && current.include?("server-entry.js")
            sleep 0.1
          end
          current, = Open3.capture2e("ps", "-p", record["pid"].to_s, "-o", "lstart=", "-o", "command=")
          Process.kill("KILL", record["pid"]) if current.include?(record["processStartTime"]) && current.include?("server-entry.js")
        end
      end
    end
  end
end
